import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');

async function fill() {
  console.log('Opening database at:', dbPath);
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // 1. Ensure active session exists
  let session = await db.get("SELECT * FROM sessions WHERE status = 'open' OR status = 'active' ORDER BY id DESC LIMIT 1");
  if (!session) {
    console.log('No active session found, creating one...');
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
    const res = await db.run("INSERT INTO sessions (date, status) VALUES (?, 'open')", [today]);
    session = { id: res.lastID, date: today, status: 'open' };
  }
  console.log(`Using Session ID: ${session.id} (${session.date})`);

  // 2. Register players if we don't have enough
  const existingPlayers = await db.all("SELECT id FROM players WHERE username != 'admin'");
  const playersNeeded = Math.max(0, 16 - existingPlayers.length);
  
  if (playersNeeded > 0) {
    console.log(`Creating ${playersNeeded} dummy players...`);
    const genders = ['M', 'F'];
    for (let i = 0; i < playersNeeded; i++) {
      const idx = existingPlayers.length + i + 1;
      const name = `Player ${idx}`;
      const gender = genders[i % 2];
      const level = Math.floor(Math.random() * 9) + 1; // 1 to 9
      const username = `player${idx}@example.com`;
      await db.run(
        "INSERT INTO players (name, gender, level, username, is_admin) VALUES (?, ?, ?, ?, 0)",
        [name, gender, level, username]
      );
    }
  }

  // 3. Clear existing signups for this session to start fresh
  await db.run("DELETE FROM signups WHERE session_id = ?", [session.id]);

  // 4. Signup exactly 16 players
  const allPlayers = await db.all("SELECT id, name FROM players WHERE username != 'admin' LIMIT 16");
  console.log(`Signing up ${allPlayers.length} players for session...`);
  for (const player of allPlayers) {
    await db.run(
      "INSERT INTO signups (session_id, player_id, status) VALUES (?, ?, 'approved')",
      [session.id, player.id]
    );
  }

  console.log('Successfully filled session with 16 approved players!');
  await db.close();
}

fill().catch(err => {
  console.error('Error filling database:', err);
  process.exit(1);
});
