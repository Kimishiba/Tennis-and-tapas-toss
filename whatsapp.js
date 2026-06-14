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
        let nameToIn = text.replace(/^!in/i, '').trim();
        // If they just write !in, use the pushName from WhatsApp
        if (!nameToIn) {
          nameToIn = msg.pushName || '';
        }
        if (!nameToIn) {
          await sock.sendMessage(groupJid, { text: `❌ Could not detect your name. Please use: !in [Your Name]` });
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
            const gender = guessGender(nameToIn);
            const level = Math.floor(Math.random() * 5) + 3; // level 3-7
            const firstWord = nameToIn.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
            const username = `${firstWord}${Date.now().toString().slice(-4)}@example.com`;

            const insertRes = await dbRef.run(
              "INSERT INTO players (name, gender, level, username, is_admin) VALUES (?, ?, ?, ?, 0)",
              [nameToIn, gender, level, username]
            );
            player = { id: insertRes.lastID, name: nameToIn, gender, level };
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
            text: `✅ ${player.name} is checked in! Total checked-in players: ${approvedCount}.`
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

          await sock.sendMessage(groupJid, { text: responseText });
        } catch (err) {
          console.error('Error in !generate command:', err);
          await sock.sendMessage(groupJid, { text: `❌ Error: ${err.message}` });
        }
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
