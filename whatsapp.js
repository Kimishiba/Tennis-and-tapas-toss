import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import qrcode from 'qrcode-terminal';

let sock = null;
let isConnected = false;
let lastQr = null;

export async function initWhatsApp(dbDir) {
  const sessionDir = path.join(dbDir, 'whatsapp-session');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307], isLatest: false }));
  console.log(`Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);

  const connectToWhatsApp = () => {
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
        }

        if (shouldReconnect) {
          connectToWhatsApp();
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
