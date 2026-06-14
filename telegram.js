import { Telegraf } from 'telegraf';

let bot = null;
let dbRef = null;
let serverHelpers = {};
let isConnected = false;

// Helper to guess gender
const guessGender = (name) => {
  const femaleNames = ['sofia', 'sofía', 'alice', 'fiona', 'emma', 'helen', 'diana', 'grace', 'beatrice', 'chloe', 'olivia', 'ava', 'isabella', 'mia', 'charlotte', 'amelia', 'sophia', 'maria', 'giulia', 'chiara', 'francesca', 'silvia', 'sara', 'elena', 'anna', 'laura', 'valentina', 'federica', 'alessandra', 'martina'];
  const firstWord = name.split(/\s+/)[0].toLowerCase().trim();
  if (femaleNames.includes(firstWord)) return 'F';
  
  // Suffix rule: ends in 'a' but not Mattia, Luca, Lucas, Andrea
  if (firstWord.endsWith('a') && !['lucas', 'andrea', 'mattia', 'luca'].includes(firstWord)) {
    return 'F';
  }
  return 'M';
};

// Option A: Rule/Regex Heuristic parser
const parseHeuristics = (text) => {
  const t = text.toLowerCase().trim();
  
  // 1. Set courts count/list
  let match = t.match(/(?:set|change|have|got)\s+(?:the\s+)?(?:number of\s+)?courts?\s+(?:to\s+)?(\d+)/i);
  if (match) {
    const count = parseInt(match[1], 10);
    const courts = [];
    for (let i = 1; i <= count; i++) courts.push(`Court ${i}`);
    return { action: 'SET_COURTS', courts };
  }

  // e.g. "courts are center, clay, hard"
  match = t.match(/courts?\s+(?:are|setup|to|names?)\s+(.+)/i);
  if (match) {
    const list = match[1].split(',').map(s => s.trim().replace(/^and\s+/i, '').trim()).filter(Boolean);
    if (list.length > 0) {
      return { action: 'SET_COURTS', courts: list.map(name => name.charAt(0).toUpperCase() + name.slice(1)) };
    }
  }

  // 2. Rename court
  match = t.match(/rename\s+(?:court\s+)?(.+?)\s+to\s+(.+)/i);
  if (match) {
    return { action: 'RENAME_COURT', oldCourtName: match[1].trim(), courtName: match[2].trim() };
  }

  // 3. Swap players
  match = t.match(/swap\s+(.+?)\s+and\s+(.+)/i);
  if (match) {
    return { action: 'SWAP_PLAYERS', playerA: match[1].trim(), playerB: match[2].trim() };
  }

  // 4. Move player
  match = t.match(/move\s+(.+?)\s+to\s+(?:court\s+)?(.+)/i);
  if (match) {
    return { action: 'MOVE_PLAYER', playerA: match[1].trim(), courtName: match[2].trim() };
  }

  return { action: 'UNKNOWN' };
};

// Option B: Gemini AI Parser
const parseWithGemini = async (apiKey, text) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const systemInstruction = `You are a bot administrator assistant for a tennis toss matchmaking system.
Analyze the user's input and extract their administrative intent into a structured JSON object.

Intents support:
1. SET_COURTS: User wants to set the number of courts or specify a list of court names. E.g., "we have 3 courts today", "courts are center, court 2, court 3".
2. RENAME_COURT: User wants to rename a specific court. E.g., "rename court 1 to Main Court".
3. SWAP_PLAYERS: User wants to swap two players in the pairings. E.g., "swap Bob and Alice".
4. MOVE_PLAYER: User wants to move a player to a specific court. E.g., "move Bob to Court 2".

Output EXACTLY a JSON block with the following fields:
{
  "action": "SET_COURTS" | "RENAME_COURT" | "SWAP_PLAYERS" | "MOVE_PLAYER" | "UNKNOWN",
  "courts": ["Court A", "Court B"], // List of court names for SET_COURTS
  "playerA": "Alice", // Player name for SWAP_PLAYERS or MOVE_PLAYER
  "playerB": "Bob", // Player name to swap with for SWAP_PLAYERS
  "courtName": "Center Court", // Target court name for MOVE_PLAYER or RENAME_COURT
  "oldCourtName": "Court 1" // Court name to change from for RENAME_COURT
}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `System Instructions:\n${systemInstruction}\n\nUser Input:\n"${text}"` }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }
    const data = await response.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (resultText) {
      return JSON.parse(resultText);
    }
  } catch (err) {
    console.error('[Telegram Bot] Gemini parse error, falling back to heuristics:', err);
  }
  return null;
};

// Post updated pairings to chat and sync to WhatsApp
async function postUpdatedPairings(ctx, sessionId, roundNumber) {
  try {
    const pairings = await dbRef.all(`
      SELECT m.*, 
        p1.name as p1_name, p1.gender as p1_gender, p1.level as p1_level,
        p2.name as p2_name, p2.gender as p2_gender, p2.level as p2_level,
        p3.name as p3_name, p3.gender as p3_gender, p3.level as p3_level,
        p4.name as p4_name, p4.gender as p4_gender, p4.level as p4_level
      FROM matches m
      JOIN players p1 ON m.player1 = p1.id
      JOIN players p2 ON m.player2 = p2.id
      JOIN players p3 ON m.player3 = p3.id
      JOIN players p4 ON m.player4 = p4.id
      WHERE m.session_id = ? AND m.round_number = ?
      ORDER BY m.court ASC
    `, [sessionId, roundNumber]);

    const nameMap = await serverHelpers.getDifferentiatedNamesMap();
    const formatPlayer = (id, defaultName) => (id && nameMap.has(id)) ? nameMap.get(id) : defaultName;

    let responseText = `🎾 *ROUND ${roundNumber} PAIRINGS UPDATED!*\n\n`;
    pairings.forEach((m) => {
      const p1 = formatPlayer(m.player1, m.p1_name);
      const p2 = formatPlayer(m.player2, m.p2_name);
      const p3 = formatPlayer(m.player3, m.p3_name);
      const p4 = formatPlayer(m.player4, m.p4_name);
      responseText += `*Court ${m.court}*\n`;
      responseText += `${p1} & ${p2} vs ${p3} & ${p4}\n\n`;
    });

    await ctx.replyWithMarkdownV2(
      responseText
        .replace(/\./g, '\\.')
        .replace(/-/g, '\\-')
        .replace(/\!/g, '\\!')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/\+/g, '\\+')
    );

    // Also sync to WhatsApp!
    if (serverHelpers.sendWhatsAppNotification) {
      serverHelpers.sendWhatsAppNotification(responseText).catch(err => {
        console.error('[Telegram Bot] Failed to send WhatsApp notification:', err);
      });
    }
  } catch (err) {
    console.error('[Telegram Bot] Error printing updated pairings:', err);
  }
}

// Handler execution engine
async function handleNaturalLanguageManage(ctx, text) {
  try {
    let intent = null;
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      intent = await parseWithGemini(apiKey, text);
    }
    
    if (!intent || intent.action === 'UNKNOWN') {
      intent = parseHeuristics(text);
    }

    if (!intent || intent.action === 'UNKNOWN') {
      return ctx.reply('🤔 Sorry, I couldn\'t understand that command. Try something like:\n• "swap John and Mark"\n• "move Alice to Court 2"\n• "we have 3 courts today"\n• "rename court 1 to Central"');
    }

    const session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
    if (!session) {
      return ctx.reply('❌ No active session found.');
    }

    if (intent.action === 'SET_COURTS') {
      const courts = intent.courts;
      if (!Array.isArray(courts) || courts.length === 0) {
        return ctx.reply('❌ Invalid court configuration received.');
      }
      await dbRef.run("UPDATE sessions SET courts_json = ? WHERE id = ?", [JSON.stringify(courts), session.id]);
      return ctx.reply(`✅ Active courts updated to:\n${courts.map(c => `• ${c}`).join('\n')}`);
    }

    if (intent.action === 'RENAME_COURT') {
      const { oldCourtName, courtName } = intent;
      if (!oldCourtName || !courtName) {
        return ctx.reply('❌ Please specify the court you want to rename and its new name.');
      }

      let parsed = [];
      if (session.courts_json) {
        try { parsed = JSON.parse(session.courts_json); } catch(e){}
      }
      
      const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
      const activeRound = lastMatch?.max_round || 1;
      
      if (parsed.length === 0) {
        const uniqueCourts = await dbRef.all("SELECT DISTINCT court FROM matches WHERE session_id = ? AND round_number = ?", [session.id, activeRound]);
        parsed = uniqueCourts.map(uc => uc.court.toString());
      }

      let renamed = false;
      const updatedCourts = parsed.map(c => {
        if (c.toString().toLowerCase() === oldCourtName.toLowerCase()) {
          renamed = true;
          return courtName;
        }
        return c;
      });

      if (!renamed) {
        return ctx.reply(`❌ Could not find court named "${oldCourtName}" in the active setup.`);
      }

      await dbRef.run("UPDATE sessions SET courts_json = ? WHERE id = ?", [JSON.stringify(updatedCourts), session.id]);

      // Update existing matches in active round
      await dbRef.run(
        "UPDATE matches SET court = ? WHERE session_id = ? AND round_number = ? AND LOWER(court) = LOWER(?)",
        [courtName, session.id, activeRound, oldCourtName]
      );

      return ctx.reply(`✅ Renamed court "${oldCourtName}" to "${courtName}" in this session.`);
    }

    if (intent.action === 'SWAP_PLAYERS') {
      const { playerA: pAName, playerB: pBName } = intent;
      if (!pAName || !pBName) {
        return ctx.reply('❌ Please specify both players to swap.');
      }

      const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
      const activeRound = lastMatch?.max_round;
      if (!activeRound) {
        return ctx.reply('❌ No matches have been generated yet for this session.');
      }

      const matches = await dbRef.all("SELECT * FROM matches WHERE session_id = ? AND round_number = ?", [session.id, activeRound]);
      if (matches.length === 0) {
        return ctx.reply('❌ No active matches found in the current round.');
      }

      const allPlayersInRound = await dbRef.all(`
        SELECT p.id, p.name FROM players p
        JOIN signups s ON p.id = s.player_id
        WHERE s.session_id = ? AND s.status = 'approved'
      `, [session.id]);

      const findBestPlayer = (inputName) => {
        const query = inputName.toLowerCase().trim();
        let found = allPlayersInRound.find(p => p.name.toLowerCase() === query);
        if (found) return found;
        found = allPlayersInRound.find(p => p.name.toLowerCase().startsWith(query));
        if (found) return found;
        found = allPlayersInRound.find(p => p.name.toLowerCase().includes(query));
        return found;
      };

      const playerA = findBestPlayer(pAName);
      const playerB = findBestPlayer(pBName);

      if (!playerA) return ctx.reply(`❌ Could not find player matching "${pAName}" in this session.`);
      if (!playerB) return ctx.reply(`❌ Could not find player matching "${pBName}" in this session.`);

      let matchA = null, slotA = null;
      let matchB = null, slotB = null;

      for (const m of matches) {
        if (m.player1 === playerA.id) { matchA = m; slotA = 'player1'; }
        if (m.player2 === playerA.id) { matchA = m; slotA = 'player2'; }
        if (m.player3 === playerA.id) { matchA = m; slotA = 'player3'; }
        if (m.player4 === playerA.id) { matchA = m; slotA = 'player4'; }

        if (m.player1 === playerB.id) { matchB = m; slotB = 'player1'; }
        if (m.player2 === playerB.id) { matchB = m; slotB = 'player2'; }
        if (m.player3 === playerB.id) { matchB = m; slotB = 'player3'; }
        if (m.player4 === playerB.id) { matchB = m; slotB = 'player4'; }
      }

      if (!matchA && !matchB) {
        return ctx.reply(`❌ Neither ${playerA.name} nor ${playerB.name} are assigned to any match in Round ${activeRound}.`);
      }

      if (matchA && matchB && matchA.id === matchB.id && slotA === slotB) {
        return ctx.reply(`😊 ${playerA.name} and ${playerB.name} are the same person!`);
      }

      if (!matchA) {
        // Player A is resting, Player B is playing. Substitute A for B.
        await dbRef.run(`UPDATE matches SET ${slotB} = ? WHERE id = ?`, [playerA.id, matchB.id]);
        await postUpdatedPairings(ctx, session.id, activeRound);
        return;
      }

      if (!matchB) {
        // Player B is resting, Player A is playing. Substitute B for A.
        await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerB.id, matchA.id]);
        await postUpdatedPairings(ctx, session.id, activeRound);
        return;
      }

      // Both are playing, perform swap
      await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerB.id, matchA.id]);
      await dbRef.run(`UPDATE matches SET ${slotB} = ? WHERE id = ?`, [playerA.id, matchB.id]);

      await postUpdatedPairings(ctx, session.id, activeRound);
      return;
    }

    if (intent.action === 'MOVE_PLAYER') {
      const { playerA: pAName, courtName } = intent;
      if (!pAName || !courtName) {
        return ctx.reply('❌ Please specify the player and the target court.');
      }

      const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
      const activeRound = lastMatch?.max_round;
      if (!activeRound) {
        return ctx.reply('❌ No matches have been generated yet for this session.');
      }

      const matches = await dbRef.all("SELECT * FROM matches WHERE session_id = ? AND round_number = ?", [session.id, activeRound]);
      if (matches.length === 0) {
        return ctx.reply('❌ No active matches found in the current round.');
      }

      const allPlayersInRound = await dbRef.all(`
        SELECT p.id, p.name FROM players p
        JOIN signups s ON p.id = s.player_id
        WHERE s.session_id = ? AND s.status = 'approved'
      `, [session.id]);

      const findBestPlayer = (inputName) => {
        const query = inputName.toLowerCase().trim();
        let found = allPlayersInRound.find(p => p.name.toLowerCase() === query);
        if (found) return found;
        found = allPlayersInRound.find(p => p.name.toLowerCase().startsWith(query));
        if (found) return found;
        found = allPlayersInRound.find(p => p.name.toLowerCase().includes(query));
        return found;
      };

      const playerA = findBestPlayer(pAName);
      if (!playerA) return ctx.reply(`❌ Could not find player matching "${pAName}" in this session.`);

      let matchA = null, slotA = null;
      for (const m of matches) {
        if (m.player1 === playerA.id) { matchA = m; slotA = 'player1'; }
        if (m.player2 === playerA.id) { matchA = m; slotA = 'player2'; }
        if (m.player3 === playerA.id) { matchA = m; slotA = 'player3'; }
        if (m.player4 === playerA.id) { matchA = m; slotA = 'player4'; }
      }

      if (!matchA) return ctx.reply(`❌ Player ${playerA.name} is not currently playing in Round ${activeRound}.`);

      const targetMatch = matches.find(m => m.court.toString().toLowerCase() === courtName.toLowerCase() || m.court.toString() === courtName);
      if (!targetMatch) {
        return ctx.reply(`❌ Could not find active court named "${courtName}" in this round.`);
      }

      if (matchA.id === targetMatch.id) {
        return ctx.reply(`😊 ${playerA.name} is already playing on court ${courtName}.`);
      }

      const playerBId = targetMatch[slotA];
      await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerBId, matchA.id]);
      await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerA.id, targetMatch.id]);

      await postUpdatedPairings(ctx, session.id, activeRound);
      return;
    }

  } catch (err) {
    console.error('[Telegram Bot] Error managing pairings:', err);
    return ctx.reply(`❌ Error processing request: ${err.message}`);
  }
}

export async function initTelegram(dbInstance, helpers = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Telegram Bot] TELEGRAM_BOT_TOKEN not set. Telegram bot will not be initialized.');
    return;
  }

  dbRef = dbInstance;
  serverHelpers = helpers;

  try {
    bot = new Telegraf(token);

    // Command to check in: /in or /in Name, Gender, Level
    bot.command('in', async (ctx) => {
      try {
        const text = ctx.message.text || '';
        const commandArgs = text.replace(/^\/in\s*/i, '').trim();

        let nameToIn = '';
        let genderInput = null;
        let levelInput = null;

        if (commandArgs) {
          const parts = commandArgs.split(',');
          nameToIn = parts[0] ? parts[0].trim() : '';
          
          if (parts[1]) {
            const g = parts[1].trim().toUpperCase();
            if (g === 'M' || g === 'F') genderInput = g;
          }
          
          if (parts[2]) {
            const l = parseInt(parts[2].trim(), 10);
            if (!isNaN(l) && l >= 1 && l <= 9) levelInput = l;
          }
        }

        // Fall back to Telegram user info if name is not explicitly passed
        if (!nameToIn) {
          const first = ctx.from.first_name || '';
          const last = ctx.from.last_name || '';
          nameToIn = `${first} ${last}`.trim() || ctx.from.username || 'Telegram Player';
        }

        // Get active session
        let session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
        if (!session) {
          const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
          const insertRes = await dbRef.run("INSERT INTO sessions (date, status) VALUES (?, 'open')", [today]);
          session = { id: insertRes.lastID, date: today, status: 'open' };
        }

        // Find or create player
        let player = await dbRef.get("SELECT * FROM players WHERE LOWER(name) = LOWER(?)", [nameToIn]);
        if (!player) {
          const gender = genderInput || guessGender(nameToIn);
          const level = levelInput || Math.floor(Math.random() * 5) + 3; // level 3-7
          const firstWord = nameToIn.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
          const username = `tg_${firstWord}${Date.now().toString().slice(-4)}@example.com`;

          const insertRes = await dbRef.run(
            "INSERT INTO players (name, gender, level, username, is_admin) VALUES (?, ?, ?, ?, 0)",
            [nameToIn, gender, level, username]
          );
          player = { id: insertRes.lastID, name: nameToIn, gender, level };
        } else {
          // Update gender/level if explicitly provided
          let needsUpdate = false;
          let queryParts = [];
          let queryArgs = [];
          if (genderInput && player.gender !== genderInput) {
            queryParts.push("gender = ?");
            queryArgs.push(genderInput);
            player.gender = genderInput;
            needsUpdate = true;
          }
          if (levelInput && player.level !== levelInput) {
            queryParts.push("level = ?");
            queryArgs.push(levelInput);
            player.level = levelInput;
            needsUpdate = true;
          }
          if (needsUpdate) {
            queryArgs.push(player.id);
            await dbRef.run(`UPDATE players SET ${queryParts.join(', ')} WHERE id = ?`, queryArgs);
          }
        }

        // Register signup
        await dbRef.run(
          "INSERT OR IGNORE INTO signups (session_id, player_id, status) VALUES (?, ?, 'approved')",
          [session.id, player.id]
        );

        const approvedCount = (await dbRef.all(
          "SELECT player_id FROM signups WHERE session_id = ? AND status = 'approved'",
          [session.id]
        )).length;

        await ctx.reply(`✅ ${player.name} (${player.gender}, Level ${player.level}) is checked in! Total checked-in players: ${approvedCount}.`);
      } catch (err) {
        console.error('[Telegram Bot] Error in /in command:', err);
        await ctx.reply(`❌ Error checking in: ${err.message}`);
      }
    });

    // Command to generate pairings: /generate
    bot.command('generate', async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const userId = ctx.from.id;

        // Verify if sender is a group admin
        let isAdmin = false;
        if (ctx.chat.type === 'private') {
          // In private chat with the bot, allow trigger for ease of testing
          isAdmin = true;
        } else {
          const chatMember = await ctx.telegram.getChatMember(chatId, userId);
          isAdmin = chatMember.status === 'administrator' || chatMember.status === 'creator';
        }

        if (!isAdmin) {
          return ctx.reply('❌ Only group administrators can trigger pairings generation.');
        }

        // Get active session
        const session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
        if (!session) {
          return ctx.reply('❌ No active session found.');
        }

        // Get approved players
        const approvedPlayers = await dbRef.all(`
          SELECT p.id, p.name, p.gender, p.level FROM signups s
          JOIN players p ON s.player_id = p.id
          WHERE s.session_id = ? AND s.status = 'approved'
        `, [session.id]);

        if (approvedPlayers.length === 0) {
          return ctx.reply('❌ Cannot generate pairings: No players are currently checked in.');
        }

        let courtsConfig = [];
        if (session.courts_json) {
          try {
            const parsed = JSON.parse(session.courts_json);
            if (Array.isArray(parsed) && parsed.length > 0) {
              courtsConfig = parsed.map(c => typeof c === 'string' ? { courtNumber: c } : c);
            }
          } catch (e) {
            console.error('[Telegram Bot] Failed to parse courts_json:', e);
          }
        }
        if (courtsConfig.length === 0) {
          const numCourts = Math.max(1, Math.floor(approvedPlayers.length / 4));
          for (let i = 1; i <= numCourts; i++) {
            courtsConfig.push({ courtNumber: i.toString() });
          }
        }

        const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
        const nextRound = (lastMatch?.max_round || 0) + 1;

        const pairings = await serverHelpers.generatePairings(session.id, nextRound, approvedPlayers, courtsConfig, {});
        if (!pairings || pairings.length === 0) {
          return ctx.reply('❌ Failed to generate pairings.');
        }

        for (const m of pairings) {
          await dbRef.run(`
            INSERT INTO matches (
              session_id, round_number, court,
              player1, player2, player3, player4,
              team_a_score, team_b_score
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          `, [
            session.id, nextRound, m.court,
            m.player1.id, m.player2.id, m.player3.id, m.player4.id
          ]);
        }

        const nameMap = await serverHelpers.getDifferentiatedNamesMap();
        const formatPlayer = (p) => (p && nameMap.has(p.id)) ? nameMap.get(p.id) : (p ? p.name : 'TBD');

        let responseText = `🎾 *ROUND ${nextRound} PAIRINGS GENERATED!*\n\n`;
        pairings.forEach((m) => {
          responseText += `*Court ${m.court}*\n`;
          responseText += `${formatPlayer(m.player1)} & ${formatPlayer(m.player2)} vs ${formatPlayer(m.player3)} & ${formatPlayer(m.player4)}\n\n`;
        });

        await ctx.replyWithMarkdownV2(
          responseText
            .replace(/\./g, '\\.')
            .replace(/-/g, '\\-')
            .replace(/\!/g, '\\!')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/\+/g, '\\+')
        );

        if (serverHelpers.sendWhatsAppNotification) {
          serverHelpers.sendWhatsAppNotification(responseText).catch(err => {
            console.error('[Telegram Bot] Failed to send WhatsApp notification:', err);
          });
        }
      } catch (err) {
        console.error('[Telegram Bot] Error in /generate command:', err);
        await ctx.reply(`❌ Error generating pairings: ${err.message}`);
      }
    });

    // Command to manage pairings / courts naturally: /manage
    bot.command('manage', async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const userId = ctx.from.id;

        // Verify if sender is a group admin
        let isAdmin = false;
        if (ctx.chat.type === 'private') {
          isAdmin = true;
        } else {
          const chatMember = await ctx.telegram.getChatMember(chatId, userId);
          isAdmin = chatMember.status === 'administrator' || chatMember.status === 'creator';
        }

        if (!isAdmin) {
          return ctx.reply('❌ Only group administrators can manage pairings.');
        }

        const text = ctx.message.text || '';
        const commandArgs = text.replace(/^\/manage\s*/i, '').trim();

        if (!commandArgs) {
          return ctx.reply('💡 Usage: /manage [instruction], e.g., "/manage swap John and Mark" or "/manage move Alice to court 2"');
        }

        await handleNaturalLanguageManage(ctx, commandArgs);
      } catch (err) {
        console.error('[Telegram Bot] Error in /manage command:', err);
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    // Command to check system status: /status
    bot.command('status', async (ctx) => {
      try {
        const chatId = ctx.chat.id;
        const userId = ctx.from.id;
        console.log(`[Telegram Bot] /status command run. Chat ID: ${chatId} (Type: ${ctx.chat.type})`);

        // Verify if sender is a group admin
        let isAdmin = false;
        if (ctx.chat.type === 'private') {
          isAdmin = true;
        } else {
          const chatMember = await ctx.telegram.getChatMember(chatId, userId);
          isAdmin = chatMember.status === 'administrator' || chatMember.status === 'creator';
        }

        if (!isAdmin) {
          return ctx.reply('❌ Only group administrators can check system status.');
        }

        // 1. Telegram status
        const tgStatus = isConnected ? '✅ Connected' : '❌ Disconnected';

        // 2. WhatsApp status
        let waStatus = '⚠️ Status unavailable';
        if (serverHelpers.getWhatsAppStatus) {
          const wa = serverHelpers.getWhatsAppStatus();
          if (wa.isConnected) {
            waStatus = '✅ Connected';
          } else if (wa.qr) {
            waStatus = '🔄 Awaiting QR scan (check server logs)';
          } else {
            waStatus = '❌ Disconnected';
          }
        }

        // 3. Active session info
        let sessionInfo = 'No active session';
        let playerCount = 0;
        let roundInfo = 'No rounds yet';
        const session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
        if (session) {
          const approved = await dbRef.all(
            "SELECT player_id FROM signups WHERE session_id = ? AND status = 'approved'",
            [session.id]
          );
          playerCount = approved.length;
          sessionInfo = `#${session.id} — ${session.date} (${session.status})`;

          const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
          if (lastMatch?.max_round) {
            const matchCount = await dbRef.get('SELECT COUNT(*) as cnt FROM matches WHERE session_id = ? AND round_number = ?', [session.id, lastMatch.max_round]);
            roundInfo = `Round ${lastMatch.max_round} (${matchCount.cnt} courts)`;
          }
        }

        // 4. Environment hints
        const hasTgGroupId = !!process.env.TELEGRAM_GROUP_CHAT_ID;
        const hasWaGroupJid = !!process.env.WHATSAPP_GROUP_JID;
        const hasGeminiKey = !!process.env.GEMINI_API_KEY;

        const statusText =
          `📊 *System Status*\n\n` +
          `*Telegram Bot:* ${tgStatus}\n` +
          `*WhatsApp Client:* ${waStatus}\n\n` +
          `*Active Session:* ${sessionInfo}\n` +
          `*Checked-in Players:* ${playerCount}\n` +
          `*Current Round:* ${roundInfo}\n\n` +
          `*Config:*\n` +
          `• TG Group Chat ID: ${hasTgGroupId ? '✅ Set' : '⚠️ Not set'}\n` +
          `• WA Group JID: ${hasWaGroupJid ? '✅ Set' : '⚠️ Not set (using default)'}\n` +
          `• Gemini API Key: ${hasGeminiKey ? '✅ Set' : '⚠️ Not set (heuristics only)'}`;

        await ctx.replyWithMarkdownV2(
          statusText
            .replace(/\./g, '\\.')
            .replace(/-/g, '\\-')
            .replace(/!/g, '\\!')
            .replace(/\(/g, '\\(')
            .replace(/\)/g, '\\)')
            .replace(/\+/g, '\\+')
            .replace(/#/g, '\\#')
        );
      } catch (err) {
        console.error('[Telegram Bot] Error in /status command:', err);
        await ctx.reply(`❌ Error fetching status: ${err.message}`);
      }
    });

    // General message listener for direct message management or group mentions
    bot.on('message', async (ctx) => {
      try {
        const text = ctx.message?.text || '';
        if (ctx.chat.type !== 'private') {
          console.log(`[Telegram Bot] Message in group/channel. Chat ID: ${ctx.chat.id}, Text: "${text}"`);
        }
        if (!text) return;

        // Skip commands
        if (text.startsWith('/')) return;

        const isDirectMessage = ctx.chat.type === 'private';
        const botUsername = ctx.botInfo?.username;
        const isMentioned = botUsername && text.includes(`@${botUsername}`);

        if (!isDirectMessage && !isMentioned) {
          return;
        }

        // Clean mention from text
        let cleanedText = text;
        if (botUsername) {
          cleanedText = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
        }

        if (!cleanedText) return;

        // Verify if sender is a group admin
        let isAdmin = false;
        if (isDirectMessage) {
          isAdmin = true;
        } else {
          const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
          isAdmin = chatMember.status === 'administrator' || chatMember.status === 'creator';
        }

        if (!isAdmin) {
          return ctx.reply('❌ Only group administrators can manage pairings.');
        }

        await handleNaturalLanguageManage(ctx, cleanedText);
      } catch (err) {
        console.error('[Telegram Bot] Error in message listener:', err);
      }
    });

    // Start / Help Commands
    const helpMessage = `📖 *Tennis \& Tapas Toss Bot Commands*:\n\n` +
      `• /in \\- Check yourself in using your Telegram name\\.\n` +
      `• /in \\[Name\\], \\[Gender: M/F\\], \\[Level: 1\\-9\\] \\- Check in with custom details \\(e\\.g\\. \`/in Sofia, F, 6\`\\)\\.\n` +
      `• /generate \\- \\(Admins only\\) Generate pairings for the active session\\.\n` +
      `• /manage \\[Instruction\\] \\- \\(Admins only\\) Manage courts or pairings naturally \\(e\\.g\\. \`/manage swap John and Mark\`\\).\n` +
      `• /status \\- \\(Admins only\\) Check system connectivity \\& session info\\.\n` +
      `• /help \\- Show this guide\\.`;

    bot.start(async (ctx) => {
      await ctx.replyWithMarkdownV2(helpMessage);
    });

    bot.help(async (ctx) => {
      await ctx.replyWithMarkdownV2(helpMessage);
    });

    // Register commands with Telegram UI menu helper
    bot.telegram.setMyCommands([
      { command: 'in', description: 'Check in to play' },
      { command: 'generate', description: 'Generate pairings (Admins only)' },
      { command: 'manage', description: 'Manage courts or pairings naturally' },
      { command: 'status', description: 'Check system connectivity & session info (Admins)' },
      { command: 'help', description: 'Show available commands' }
    ]).catch(err => console.error('[Telegram Bot] Failed to register menu commands:', err));

    bot.launch();
    isConnected = true;
    console.log('[Telegram Bot] Success: Bot is connected and listening!');

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (err) {
    console.error('[Telegram Bot] Failed to initialize bot connection:', err);
  }
}

export async function sendTelegramNotification(message) {
  const chatId = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (!chatId) {
    console.log('[Telegram Notification] (Dry Run - No TELEGRAM_GROUP_CHAT_ID set):\n', message);
    return;
  }

  if (!isConnected || !bot) {
    console.warn('[Telegram Notification] Cannot send message: Bot is not initialized.');
    return;
  }

  try {
    await bot.telegram.sendMessage(chatId, message);
    console.log('[Telegram Notification] Message sent to chat:', chatId);
  } catch (err) {
    console.error('[Telegram Notification] Failed to send message to Telegram:', err);
  }
}
