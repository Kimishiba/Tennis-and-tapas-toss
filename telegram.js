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

        const numCourts = Math.max(1, Math.floor(approvedPlayers.length / 4));
        const courtsConfig = [];
        for (let i = 1; i <= numCourts; i++) {
          courtsConfig.push({ courtNumber: i.toString() });
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
              session_id, round_number, court_number,
              player1, player2, player3, player4,
              score1, score2, is_published
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)
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
      } catch (err) {
        console.error('[Telegram Bot] Error in /generate command:', err);
        await ctx.reply(`❌ Error generating pairings: ${err.message}`);
      }
    });

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
