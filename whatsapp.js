import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode-terminal';

let dbRef = null;
let serverHelpers = {};
let sock = null;
let isConnected = false;
let lastQr = null;

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

  // 3.2 Swap players alternative
  match = t.match(/swap\s+(.+?)\s+(?:with|out for)\s+(.+)/i);
  if (match) {
    return { action: 'SWAP_PLAYERS', playerA: match[1].trim(), playerB: match[2].trim() };
  }

  // 4. Move player
  match = t.match(/move\s+(.+?)\s+to\s+(?:court\s+)?(.+)/i);
  if (match) {
    return { action: 'MOVE_PLAYER', playerA: match[1].trim(), courtName: match[2].trim() };
  }

  // 5. Update level
  match = t.match(/(?:set|change|update)\s+(?:the\s+)?(?:level\s+of\s+)?(.+?)(?:'s)?(?:\s+level)?\s+to\s+(?:level\s+)?(\d+)/i);
  if (match) {
    return { action: 'UPDATE_PLAYER_LEVEL', playerA: match[1].trim(), level: parseInt(match[2], 10) };
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
5. UPDATE_PLAYER_LEVEL: User wants to update a player's level. E.g., "set Alice level to 8", "change Bob's level to 5", "update Mark to level 6".

Output EXACTLY a JSON block with the following fields:
{
  "action": "SET_COURTS" | "RENAME_COURT" | "SWAP_PLAYERS" | "MOVE_PLAYER" | "UPDATE_PLAYER_LEVEL" | "UNKNOWN",
  "courts": ["Court A", "Court B"], // List of court names for SET_COURTS
  "playerA": "Alice", // Player name for SWAP_PLAYERS, MOVE_PLAYER, or UPDATE_PLAYER_LEVEL
  "playerB": "Bob", // Player name to swap with for SWAP_PLAYERS
  "courtName": "Center Court", // Target court name for MOVE_PLAYER or RENAME_COURT
  "oldCourtName": "Court 1", // Court name to change from for RENAME_COURT
  "level": 8 // New level number (1-9) for UPDATE_PLAYER_LEVEL
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
    console.error('[WhatsApp Bot] Gemini parse error, falling back to heuristics:', err);
  }
  return null;
};

// Post updated pairings to WhatsApp chat
async function postUpdatedPairingsWhatsApp(groupJid, sessionId, roundNumber) {
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

    await sock.sendMessage(groupJid, { text: responseText });

    // Also sync to Telegram!
    if (serverHelpers.sendTelegramNotification) {
      serverHelpers.sendTelegramNotification(responseText).catch(err => {
        console.error('[WhatsApp Bot] Failed to send Telegram notification:', err);
      });
    }
  } catch (err) {
    console.error('[WhatsApp Bot] Error printing updated pairings:', err);
  }
}

// WhatsApp Natural Language Management Handler
async function handleWhatsAppNaturalLanguageManage(groupJid, text, msg) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find(p => p.id === msg.key.participant);
    const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

    if (!isAdmin) {
      await sock.sendMessage(groupJid, { text: `❌ Only group admins can manage pairings and settings.` });
      return;
    }

    let intent = null;
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      intent = await parseWithGemini(apiKey, text);
    }
    
    if (!intent || intent.action === 'UNKNOWN') {
      intent = parseHeuristics(text);
    }

    if (!intent || intent.action === 'UNKNOWN') {
      await sock.sendMessage(groupJid, { 
        text: `🤔 Sorry, I couldn't understand that command. Try something like:\n• "!swap John and Mark"\n• "!move Alice to Court 2"\n• "!we have 3 courts today"\n• "!rename court 1 to Central"\n• "!set Alice level to 8"\n• "!generate pairings"` 
      });
      return;
    }

    if (intent.action === 'UPDATE_PLAYER_LEVEL') {
      const { playerA: pAName, level } = intent;
      if (!pAName || level === undefined || isNaN(level) || level < 1 || level > 9) {
        await sock.sendMessage(groupJid, { text: '❌ Please specify a valid player name and level between 1 and 9.' });
        return;
      }

      const query = pAName.toLowerCase().trim();
      const allPlayers = await dbRef.all("SELECT id, name FROM players");
      let foundPlayer = allPlayers.find(p => p.name.toLowerCase() === query);
      if (!foundPlayer) foundPlayer = allPlayers.find(p => p.name.toLowerCase().startsWith(query));
      if (!foundPlayer) foundPlayer = allPlayers.find(p => p.name.toLowerCase().includes(query));

      if (!foundPlayer) {
        await sock.sendMessage(groupJid, { text: `❌ Could not find player matching "${pAName}".` });
        return;
      }

      await dbRef.run("UPDATE players SET level = ? WHERE id = ?", [level, foundPlayer.id]);
      await sock.sendMessage(groupJid, { text: `✅ Updated level of ${foundPlayer.name} to ${level}.` });
      return;
    }

    const session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
    if (!session) {
      await sock.sendMessage(groupJid, { text: '❌ No active session found.' });
      return;
    }

    if (intent.action === 'GENERATE_PAIRINGS') {
      const approvedPlayers = await dbRef.all(`
        SELECT p.id, p.name, p.gender, p.level FROM signups s
        JOIN players p ON s.player_id = p.id
        WHERE s.session_id = ? AND s.status = 'approved'
      `, [session.id]);

      if (approvedPlayers.length === 0) {
        await sock.sendMessage(groupJid, { text: '❌ Cannot generate pairings: No players are currently checked in.' });
        return;
      }

      let courtsConfig = [];
      if (session.courts_json) {
        try {
          const parsed = JSON.parse(session.courts_json);
          if (Array.isArray(parsed) && parsed.length > 0) {
            courtsConfig = parsed.map(c => typeof c === 'string' ? { courtNumber: c } : c);
          }
        } catch (e) {
          console.error('[WhatsApp Bot] Failed to parse courts_json:', e);
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
        await sock.sendMessage(groupJid, { text: '❌ Failed to generate pairings.' });
        return;
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

      await sock.sendMessage(groupJid, { text: responseText });

      if (serverHelpers.sendTelegramNotification) {
        serverHelpers.sendTelegramNotification(responseText).catch(err => {
          console.error('[WhatsApp Bot] Failed to send Telegram notification:', err);
        });
      }
      return;
    }

    if (intent.action === 'SET_COURTS') {
      const courts = intent.courts;
      if (!Array.isArray(courts) || courts.length === 0) {
        await sock.sendMessage(groupJid, { text: '❌ Invalid court configuration received.' });
        return;
      }
      await dbRef.run("UPDATE sessions SET courts_json = ? WHERE id = ?", [JSON.stringify(courts), session.id]);
      await sock.sendMessage(groupJid, { text: `✅ Active courts updated to:\n${courts.map(c => `• ${c}`).join('\n')}` });
      return;
    }

    if (intent.action === 'RENAME_COURT') {
      const { oldCourtName, courtName } = intent;
      if (!oldCourtName || !courtName) {
        await sock.sendMessage(groupJid, { text: '❌ Please specify the court you want to rename and its new name.' });
        return;
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
        await sock.sendMessage(groupJid, { text: `❌ Could not find court named "${oldCourtName}" in the active setup.` });
        return;
      }

      await dbRef.run("UPDATE sessions SET courts_json = ? WHERE id = ?", [JSON.stringify(updatedCourts), session.id]);
      await dbRef.run(
        "UPDATE matches SET court = ? WHERE session_id = ? AND round_number = ? AND LOWER(court) = LOWER(?)",
        [courtName, session.id, activeRound, oldCourtName]
      );

      await sock.sendMessage(groupJid, { text: `✅ Renamed court "${oldCourtName}" to "${courtName}" in this session.` });
      return;
    }

    if (intent.action === 'SWAP_PLAYERS') {
      const { playerA: pAName, playerB: pBName } = intent;
      if (!pAName || !pBName) {
        await sock.sendMessage(groupJid, { text: '❌ Please specify both players to swap.' });
        return;
      }

      const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
      const activeRound = lastMatch?.max_round;
      if (!activeRound) {
        await sock.sendMessage(groupJid, { text: '❌ No matches have been generated yet for this session.' });
        return;
      }

      const matches = await dbRef.all("SELECT * FROM matches WHERE session_id = ? AND round_number = ?", [session.id, activeRound]);
      if (matches.length === 0) {
        await sock.sendMessage(groupJid, { text: '❌ No active matches found in the current round.' });
        return;
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

      if (!playerA) {
        await sock.sendMessage(groupJid, { text: `❌ Could not find player matching "${pAName}" in this session.` });
        return;
      }
      if (!playerB) {
        await sock.sendMessage(groupJid, { text: `❌ Could not find player matching "${pBName}" in this session.` });
        return;
      }

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
        await sock.sendMessage(groupJid, { text: `❌ Neither ${playerA.name} nor ${playerB.name} are assigned to any match in Round ${activeRound}.` });
        return;
      }

      if (matchA && matchB && matchA.id === matchB.id && slotA === slotB) {
        await sock.sendMessage(groupJid, { text: `😊 ${playerA.name} and ${playerB.name} are the same person!` });
        return;
      }

      if (!matchA) {
        await dbRef.run(`UPDATE matches SET ${slotB} = ? WHERE id = ?`, [playerA.id, matchB.id]);
        await postUpdatedPairingsWhatsApp(groupJid, session.id, activeRound);
        return;
      }

      if (!matchB) {
        await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerB.id, matchA.id]);
        await postUpdatedPairingsWhatsApp(groupJid, session.id, activeRound);
        return;
      }

      await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerB.id, matchA.id]);
      await dbRef.run(`UPDATE matches SET ${slotB} = ? WHERE id = ?`, [playerA.id, matchB.id]);

      await postUpdatedPairingsWhatsApp(groupJid, session.id, activeRound);
      return;
    }

    if (intent.action === 'MOVE_PLAYER') {
      const { playerA: pAName, courtName } = intent;
      if (!pAName || !courtName) {
        await sock.sendMessage(groupJid, { text: '❌ Please specify the player and the target court.' });
        return;
      }

      const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
      const activeRound = lastMatch?.max_round;
      if (!activeRound) {
        await sock.sendMessage(groupJid, { text: '❌ No matches have been generated yet for this session.' });
        return;
      }

      const matches = await dbRef.all("SELECT * FROM matches WHERE session_id = ? AND round_number = ?", [session.id, activeRound]);
      if (matches.length === 0) {
        await sock.sendMessage(groupJid, { text: '❌ No active matches found in the current round.' });
        return;
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
      if (!playerA) {
        await sock.sendMessage(groupJid, { text: `❌ Could not find player matching "${pAName}" in this session.` });
        return;
      }

      let matchA = null, slotA = null;
      for (const m of matches) {
        if (m.player1 === playerA.id) { matchA = m; slotA = 'player1'; }
        if (m.player2 === playerA.id) { matchA = m; slotA = 'player2'; }
        if (m.player3 === playerA.id) { matchA = m; slotA = 'player3'; }
        if (m.player4 === playerA.id) { matchA = m; slotA = 'player4'; }
      }

      if (!matchA) {
        await sock.sendMessage(groupJid, { text: `❌ Player ${playerA.name} is not currently playing in Round ${activeRound}.` });
        return;
      }

      const targetMatch = matches.find(m => m.court.toString().toLowerCase() === courtName.toLowerCase() || m.court.toString() === courtName);
      if (!targetMatch) {
        await sock.sendMessage(groupJid, { text: `❌ Could not find active court named "${courtName}" in this round.` });
        return;
      }

      if (matchA.id === targetMatch.id) {
        await sock.sendMessage(groupJid, { text: `😊 ${playerA.name} is already playing on court ${courtName}.` });
        return;
      }

      const playerBId = targetMatch[slotA];
      await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerBId, matchA.id]);
      await dbRef.run(`UPDATE matches SET ${slotA} = ? WHERE id = ?`, [playerA.id, targetMatch.id]);

      await postUpdatedPairingsWhatsApp(groupJid, session.id, activeRound);
      return;
    }
  } catch (err) {
    console.error('[WhatsApp Bot] Error managing pairings:', err);
    await sock.sendMessage(groupJid, { text: `❌ Error processing request: ${err.message}` });
  }
}

export async function initWhatsApp(dbDir, dbInstance, helpers = {}) {
  dbRef = dbInstance;
  serverHelpers = helpers;

  const sessionDir = path.join(dbDir, 'whatsapp-session');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: false }));
  console.log(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

  const connectToWhatsApp = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }) // suppress verbose logs
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQr = qr;
        console.log('================================================================');
        console.log('SCAN THIS QR CODE WITH WHATSAPP (Settings > Linked Devices):');
        console.log('================================================================');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const shouldReconnect = !isLoggedOut;
        console.log('WhatsApp connection closed due to ', lastDisconnect?.error, ', reconnecting: ', shouldReconnect);
        isConnected = false;
        
        if (isLoggedOut) {
          console.log('Session is logged out or unauthorized. Clearing credentials to allow re-linking...');
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (e) {
            console.error('Failed to clear session directory:', e);
          }
          // Connect again with fresh auth state to generate QR code after a short delay
          setTimeout(connectToWhatsApp, 1000);
        } else if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 1000);
        }
      } else if (connection === 'open') {
        lastQr = null;
        console.log('================================================================');
        console.log('SUCCESS: WhatsApp client is now connected!');
        console.log('================================================================');
        isConnected = true;

        // Fetch and print groups to help user configure the group JID
        try {
          const groups = await sock.groupFetchAllParticipating();
          console.log('\n--- AVAILABLE WHATSAPP GROUPS ---');
          for (const [id, group] of Object.entries(groups)) {
            console.log(`Group Name: "${group.subject}" | JID: "${id}"`);
          }
          console.log('---------------------------------\n');
        } catch (err) {
          console.error('Failed to fetch WhatsApp groups:', err);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Group Message Commands Listener
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const groupJid = process.env.WHATSAPP_GROUP_JID || '120363408671601030@g.us';
      if (msg.key.remoteJid !== groupJid) return;

      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text) return;

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

      // 1. !in Command
      if (/^!in(\s+.*)?$/i.test(text)) {
        const commandArgs = text.replace(/^!in/i, '').trim();
        let nameToIn = '';
        let genderInput = null;
        let levelInput = null;

        if (commandArgs) {
          // Parse comma-separated arguments
          const parts = commandArgs.split(',');
          nameToIn = parts[0] ? parts[0].trim() : '';
          
          if (parts[1]) {
            const g = parts[1].trim().toUpperCase();
            if (g.startsWith('M') || g === 'MALE') genderInput = 'M';
            else if (g.startsWith('F') || g === 'FEMALE') genderInput = 'F';
          }
          
          if (parts[2]) {
            const levelStr = parts[2].trim().replace(/\D/g, '');
            const l = parseInt(levelStr, 10);
            if (!isNaN(l) && l >= 1 && l <= 9) levelInput = l;
          }
        }

        // If no name was parsed/provided, fall back to pushName
        if (!nameToIn) {
          nameToIn = msg.pushName || '';
        }

        if (!nameToIn) {
          await sock.sendMessage(groupJid, { text: `❌ Could not detect your name. Please use: !in [Name], [Gender: M/F], [Level: 1-9]` });
          return;
        }

        try {
          // Find or create active session
          let session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
          if (!session) {
            const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
            const insertRes = await dbRef.run("INSERT INTO sessions (date, status) VALUES (?, 'open')", [today]);
            session = { id: insertRes.lastID, date: today, status: 'open' };
          }

          // Check if player exists
          let player = await dbRef.get("SELECT * FROM players WHERE LOWER(name) = LOWER(?)", [nameToIn]);
          if (!player) {
            const gender = genderInput || guessGender(nameToIn);
            const level = levelInput || Math.floor(Math.random() * 5) + 3; // level 3-7
            const firstWord = nameToIn.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
            const username = `${firstWord}${Date.now().toString().slice(-4)}@example.com`;

            const insertRes = await dbRef.run(
              "INSERT INTO players (name, gender, level, username, is_admin) VALUES (?, ?, ?, ?, 0)",
              [nameToIn, gender, level, username]
            );
            player = { id: insertRes.lastID, name: nameToIn, gender, level };
          } else {
            // Update gender or level if explicitly provided and different
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

          // Register in signups
          await dbRef.run(
            "INSERT OR IGNORE INTO signups (session_id, player_id, status) VALUES (?, ?, 'approved')",
            [session.id, player.id]
          );

          const approvedCount = (await dbRef.all(
            "SELECT player_id FROM signups WHERE session_id = ? AND status = 'approved'",
            [session.id]
          )).length;

          await sock.sendMessage(groupJid, {
            text: `✅ ${player.name} (${player.gender}, Level ${player.level}) is checked in! Total checked-in players: ${approvedCount}.`
          });
        } catch (err) {
          console.error('Error in !in command:', err);
          await sock.sendMessage(groupJid, { text: `❌ Error checking in: ${err.message}` });
        }
      }

      // 2. !generate Command
      if (/^!generate$/i.test(text)) {
        try {
          const metadata = await sock.groupMetadata(groupJid);
          const participant = metadata.participants.find(p => p.id === msg.key.participant);
          const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

          if (!isAdmin) {
            await sock.sendMessage(groupJid, { text: `❌ Only group admins can trigger pairing generation.` });
            return;
          }

          const session = await dbRef.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
          if (!session) {
            await sock.sendMessage(groupJid, { text: `❌ No active session found.` });
            return;
          }

          const approvedPlayers = await dbRef.all(`
            SELECT p.id, p.name, p.gender, p.level FROM signups s
            JOIN players p ON s.player_id = p.id
            WHERE s.session_id = ? AND s.status = 'approved'
          `, [session.id]);

          if (approvedPlayers.length === 0) {
            await sock.sendMessage(groupJid, { text: `❌ Cannot generate pairings: No players are currently checked in.` });
            return;
          }

          const numCourts = Math.max(1, Math.floor(approvedPlayers.length / 4));
          const courtsConfig = [];
          for (let i = 1; i <= numCourts; i++) {
            courtsConfig.push({ courtNumber: i.toString() });
          }

          const lastMatch = await dbRef.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [session.id]);
          const nextRound = (lastMatch?.max_round || 0) + 1;

          const pairings = await serverHelpers.generatePairings(session.id, nextRound, approvedPlayers, courtsConfig, {});
          if (!pairings || pairings.length === 0) {
            await sock.sendMessage(groupJid, { text: `❌ Failed to generate pairings.` });
            return;
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

          await sock.sendMessage(groupJid, { text: responseText });

          if (serverHelpers.sendTelegramNotification) {
            serverHelpers.sendTelegramNotification(responseText).catch(err => {
              console.error('Failed to send Telegram notification:', err);
            });
          }
        } catch (err) {
          console.error('Error in !generate command:', err);
          await sock.sendMessage(groupJid, { text: `❌ Error: ${err.message}` });
        }
      }

      // 3. !status Command
      if (/^!status$/i.test(text)) {
        try {
          const metadata = await sock.groupMetadata(groupJid);
          const participant = metadata.participants.find(p => p.id === msg.key.participant);
          const isAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

          if (!isAdmin) {
            await sock.sendMessage(groupJid, { text: `❌ Only group admins can check system status.` });
            return;
          }

          const tgStatusInfo = serverHelpers.getTelegramStatus ? serverHelpers.getTelegramStatus() : null;
          const tgStatus = (tgStatusInfo && tgStatusInfo.isConnected) ? '✅ Connected' : '❌ Disconnected';
          const waStatus = isConnected ? '✅ Connected' : '❌ Disconnected';

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

          await sock.sendMessage(groupJid, { text: statusText });
        } catch (err) {
          console.error('[WhatsApp Bot] Error in !status command:', err);
          await sock.sendMessage(groupJid, { text: `❌ Error fetching status: ${err.message}` });
        }
      }

      // 4. !help Command
      if (/^!help$/i.test(text)) {
        const helpMessage = `📖 *Tennis & Tapas Toss Bot Commands*:\n\n` +
          `• *!in* - Check yourself in using your WhatsApp name.\n` +
          `• *!in [Name], [Gender: M/F], [Level: 1-9]* - Check in with custom details (e.g. \`!in Sofia, F, 6\`).\n` +
          `• *!generate* - (Admins only) Generate pairings for the active session.\n` +
          `• *!status* - (Admins only) Check system connectivity & session info.\n` +
          `• *!help* - Show this guide.\n\n` +
          `*Admins* can also send conversational commands starting with \`!\`:\n` +
          `• \`!swap John and Mark\`\n` +
          `• \`!move Alice to Court 2\`\n` +
          `• \`!we have 3 courts today\`\n` +
          `• \`!rename court 1 to Central\`\n` +
          `• \`!set Alice level to 8\`\n` +
          `• \`!generate pairings\``;
        await sock.sendMessage(groupJid, { text: helpMessage });
      }

      // 5. Natural Language Command Fallback
      if (text.startsWith('!')) {
        const lower = text.toLowerCase();
        if (
          lower.startsWith('!in') || 
          lower.startsWith('!generate') || 
          lower.startsWith('!status') || 
          lower.startsWith('!help')
        ) {
          return;
        }

        const commandText = text.substring(1).trim();
        await handleWhatsAppNaturalLanguageManage(groupJid, commandText, msg);
      }
    });
  };

  connectToWhatsApp();
}

export async function sendGroupNotification(message) {
  const groupJid = process.env.WHATSAPP_GROUP_JID || '120363408671601030@g.us';
  
  if (!groupJid) {
    console.log('[WhatsApp Notification] (Dry Run - No WHATSAPP_GROUP_JID set):\n', message);
    return;
  }

  if (!isConnected || !sock) {
    console.warn('[WhatsApp Notification] Cannot send message: WhatsApp client is not connected.');
    return;
  }

  try {
    await sock.sendMessage(groupJid, { text: message });
    console.log('[WhatsApp Notification] Message sent to group:', groupJid);
  } catch (err) {
    console.error('[WhatsApp Notification] Failed to send message to group:', err);
  }
}

export function getWhatsAppStatus() {
  return { isConnected, qr: lastQr };
}
