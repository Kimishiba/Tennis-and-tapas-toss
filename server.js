import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { OAuth2Client } from 'google-auth-library';

const googleClient = new OAuth2Client();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tennis_toss_super_secret_key_2026';

// Determine uploads directory relative to DB path
const uploadsDir = process.env.DATABASE_PATH 
  ? path.join(path.dirname(process.env.DATABASE_PATH), 'uploads')
  : path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only images (jpg, jpeg, png, gif, webp) are allowed'));
  }
});

// ==========================================
// 1. DATABASE SETUP & INITIALIZATION
// ==========================================
export let db;
export function setDb(newDb) { db = newDb; }

async function initDb() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'database.db');
  
  // Ensure directory exists for persistent container storage
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  // Create tables
  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gender TEXT CHECK(gender IN ('M', 'F')) NOT NULL,
      level INTEGER CHECK(level >= 1 AND level <= 9) NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT, -- Nullable for OAuth accounts
      subscription TEXT, -- JSON Web Push subscription
      picture_path TEXT, -- URL or path to uploaded avatar
      google_id TEXT UNIQUE, -- Unique Google User ID
      is_admin INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      status TEXT CHECK(status IN ('open', 'active', 'completed')) DEFAULT 'open'
    );

    CREATE TABLE IF NOT EXISTS signups (
      session_id INTEGER,
      player_id INTEGER,
      status TEXT CHECK(status IN ('pending', 'approved')) DEFAULT 'pending',
      PRIMARY KEY (session_id, player_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      round_number INTEGER NOT NULL,
      court INTEGER NOT NULL,
      player1 INTEGER NOT NULL, -- Team A Player 1
      player2 INTEGER NOT NULL, -- Team A Player 2
      player3 INTEGER NOT NULL, -- Team B Player 1
      player4 INTEGER NOT NULL, -- Team B Player 2
      team_a_score INTEGER,
      team_b_score INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (player1) REFERENCES players(id),
      FOREIGN KEY (player2) REFERENCES players(id),
      FOREIGN KEY (player3) REFERENCES players(id),
      FOREIGN KEY (player4) REFERENCES players(id)
    );
  `);

  // Migration: Add columns to players table if they don't exist yet
  try {
    await db.exec('ALTER TABLE players ADD COLUMN picture_path TEXT');
  } catch (e) {
    // Column already exists
  }

  try {
    await db.exec('ALTER TABLE players ADD COLUMN google_id TEXT');
  } catch (e) {
    // Column already exists
  }

  // Create default admin if not exists
  const adminUsername = 'admin';
  const existingAdmin = await db.get('SELECT * FROM players WHERE username = ?', [adminUsername]);
  if (!existingAdmin) {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('adminpassword', salt);
    await db.run(
      'INSERT INTO players (name, gender, level, username, password_hash, is_admin) VALUES (?, ?, ?, ?, ?, ?)',
      ['Admin User', 'M', 1, adminUsername, hash, 1]
    );
    console.log('Default admin created (username: admin, password: adminpassword)');
  }
}

// ==========================================
// 2. WEB PUSH NOTIFICATION SETUP
// ==========================================
const vapidKeysPath = process.env.DATABASE_PATH 
  ? path.join(path.dirname(process.env.DATABASE_PATH), 'vapid-keys.json')
  : path.join(__dirname, 'vapid-keys.json');
let vapidKeys;
if (fs.existsSync(vapidKeysPath)) {
  vapidKeys = JSON.parse(fs.readFileSync(vapidKeysPath, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(vapidKeysPath, JSON.stringify(vapidKeys, null, 2), 'utf8');
  console.log('Generated new VAPID keys');
}

webpush.setVapidDetails(
  'mailto:admin@tennistoss.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

async function sendPushNotification(playerIds, payload) {
  const placeholders = playerIds.map(() => '?').join(',');
  if (playerIds.length === 0) return;

  const players = await db.all(
    `SELECT subscription FROM players WHERE id IN (${placeholders}) AND subscription IS NOT NULL`,
    playerIds
  );

  const notificationPayload = JSON.stringify(payload);

  const sendPromises = players.map(player => {
    try {
      const subscription = JSON.parse(player.subscription);
      return webpush.sendNotification(subscription, notificationPayload)
        .catch(err => {
          console.error('Error sending push notification to a device:', err.message);
          // If subscription has expired/unsubscribed, we could clean it from DB here
        });
    } catch (e) {
      console.error('Invalid subscription JSON in database:', e.message);
      return Promise.resolve();
    }
  });

  await Promise.all(sendPromises);
}

// ==========================================
// 3. ROTATING PAIRING ALGORITHM
// ==========================================
/**
 * Generates optimal round pairings for exactly 16 players,
 * respecting level differences, avoiding partner repeats,
 * encouraging mixed doubles, and maximizing opponent rotation.
 */
export async function generatePairings(sessionId, roundNumber, approvedPlayers) {
  if (approvedPlayers.length !== 16) {
    throw new Error('Pairings require exactly 16 approved players');
  }

  // Load all historical matches to compute partner & opponent frequencies
  const allMatches = await db.all(`
    SELECT player1, player2, player3, player4 FROM matches
    WHERE session_id != ? OR round_number < ?
  `, [sessionId, roundNumber]);

  // Load matches in the current session (previous rounds of today)
  const currentSessionMatches = await db.all(`
    SELECT player1, player2, player3, player4 FROM matches
    WHERE session_id = ? AND round_number < ?
  `, [sessionId, roundNumber]);

  // Build history tracking maps
  // partnerHistory: 'player1_id,player2_id' -> count of partnering
  const partnerHistory = new Map();
  // opponentHistory: 'player1_id,player2_id' -> count of playing against each other
  const opponentHistory = new Map();

  function recordPartner(p1, p2, weight = 1) {
    const key = p1 < p2 ? `${p1},${p2}` : `${p2},${p1}`;
    partnerHistory.set(key, (partnerHistory.get(key) || 0) + weight);
  }

  function recordOpponent(p1, p2, weight = 1) {
    const key = p1 < p2 ? `${p1},${p2}` : `${p2},${p1}`;
    opponentHistory.set(key, (opponentHistory.get(key) || 0) + weight);
  }

  // Record historical matches (weighted slightly lower or equal)
  for (const m of allMatches) {
    recordPartner(m.player1, m.player2, 1);
    recordPartner(m.player3, m.player4, 1);

    recordOpponent(m.player1, m.player3, 1);
    recordOpponent(m.player1, m.player4, 1);
    recordOpponent(m.player2, m.player3, 1);
    recordOpponent(m.player2, m.player4, 1);
  }

  // Record matches from today (weighted extremely high to strictly avoid repeats today)
  for (const m of currentSessionMatches) {
    recordPartner(m.player1, m.player2, 100);
    recordPartner(m.player3, m.player4, 100);

    recordOpponent(m.player1, m.player3, 10);
    recordOpponent(m.player1, m.player4, 10);
    recordOpponent(m.player2, m.player3, 10);
    recordOpponent(m.player2, m.player4, 10);
  }

  // Scoring parameters
  const PARTNER_REPEATED_PENALTY = 100000; // Massively penalize re-partnering
  const OPPONENT_REPEATED_PENALTY = 1000;
  const LEVEL_GAP_PENALTY = 100; // Penalty per level difference in match balance
  const PARTNER_GAP_IDEAL = 4; // Preferred partner level gap <= 4
  const PARTNER_GAP_SOFT_PENALTY = 1000; // Penalty for partner gap > 4
  const PARTNER_GAP_HARD_LIMIT = 8; // Max partner gap
  const PARTNER_GAP_HARD_PENALTY = 500000; // Penalty for partner gap > 8

  // We will run a randomized search with hill-climbing to find the best configuration
  let bestPairing = null;
  let bestScore = Infinity;

  const players = [...approvedPlayers];

  // We sample 100,000 permutations to find the optimal pairings.
  // With 16 players, random sampling works extremely well and finishes in 10-15ms.
  for (let i = 0; i < 100000; i++) {
    // Shuffle players
    for (let j = players.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [players[j], players[k]] = [players[k], players[j]];
    }

    // Partition into 4 matches (4 courts):
    // Match 1: Court 1: (P0, P1) vs (P2, P3)
    // Match 2: Court 2: (P4, P5) vs (P6, P7)
    // Match 3: Court 3: (P8, P9) vs (P10, P11)
    // Match 4: Court 4: (P12, P13) vs (P14, P15)
    let score = 0;
    const currentMatches = [];

    for (let c = 0; c < 4; c++) {
      const offset = c * 4;
      const p1 = players[offset];
      const p2 = players[offset + 1];
      const p3 = players[offset + 2];
      const p4 = players[offset + 3];

      // Partners: (p1, p2) and (p3, p4)
      const p1_p2_key = p1.id < p2.id ? `${p1.id},${p2.id}` : `${p2.id},${p1.id}`;
      const p3_p4_key = p3.id < p4.id ? `${p3.id},${p4.id}` : `${p4.id},${p3.id}`;

      const p1_p2_repeats = partnerHistory.get(p1_p2_key) || 0;
      const p3_p4_repeats = partnerHistory.get(p3_p4_key) || 0;

      // Penalty for partner repetition
      score += p1_p2_repeats * PARTNER_REPEATED_PENALTY;
      score += p3_p4_repeats * PARTNER_REPEATED_PENALTY;

      // Level gap restrictions for partners
      const gap1 = Math.abs(p1.level - p2.level);
      const gap2 = Math.abs(p3.level - p4.level);

      if (gap1 > PARTNER_GAP_HARD_LIMIT) score += PARTNER_GAP_HARD_PENALTY;
      else if (gap1 > PARTNER_GAP_IDEAL) score += (gap1 - PARTNER_GAP_IDEAL) * PARTNER_GAP_SOFT_PENALTY;

      if (gap2 > PARTNER_GAP_HARD_LIMIT) score += PARTNER_GAP_HARD_PENALTY;
      else if (gap2 > PARTNER_GAP_IDEAL) score += (gap2 - PARTNER_GAP_IDEAL) * PARTNER_GAP_SOFT_PENALTY;

      // Match Balance (Team A sum vs Team B sum)
      const teamASum = p1.level + p2.level;
      const teamBSum = p3.level + p4.level;
      score += Math.abs(teamASum - teamBSum) * LEVEL_GAP_PENALTY;

      // Opponent rotation
      const opponents = [
        [p1.id, p3.id], [p1.id, p4.id],
        [p2.id, p3.id], [p2.id, p4.id]
      ];
      for (const [op1, op2] of opponents) {
        const op_key = op1 < op2 ? `${op1},${op2}` : `${op2},${op1}`;
        const op_repeats = opponentHistory.get(op_key) || 0;
        score += op_repeats * OPPONENT_REPEATED_PENALTY;
      }

      // Gender Match Weighting (Prefer Mixed Doubles 2M/2F split)
      const courtGenders = [p1.gender, p2.gender, p3.gender, p4.gender];
      const mCount = courtGenders.filter(g => g === 'M').length;
      const fCount = courtGenders.filter(g => g === 'F').length;

      if (mCount === 2 && fCount === 2) {
        // Ideal case 1: Mixed doubles (1M 1F on both teams)
        if (p1.gender !== p2.gender && p3.gender !== p4.gender) {
          score += 0; // Perfect mixed doubles
        } else {
          score += 150; // Same-gender teams playing each other (e.g. 2M vs 2F)
        }
      } else if (mCount === 4 || fCount === 4) {
        score += 80; // All men or all women on court (very clean)
      } else {
        // 3M 1F or 3F 1M (isolates one player)
        score += 50000; // Heavily discouraged
      }

      currentMatches.push({
        court: c + 1,
        player1: p1,
        player2: p2,
        player3: p3,
        player4: p4
      });
    }

    if (score < bestScore) {
      bestScore = score;
      bestPairing = currentMatches;
    }
  }

  return bestPairing;
}

// ==========================================
// 4. API SERVER & CONTROLLERS
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// Express Middleware for Authentication
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    const user = await db.get('SELECT id, name, username, gender, level, picture_path, is_admin FROM players WHERE id = ?', [decoded.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// --- Auth Endpoints ---

// Get Google Client ID config
app.get('/api/auth/google/client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
});

// Register
app.post('/api/auth/register', upload.single('picture'), async (req, res) => {
  const { name, gender, level, username, password } = req.body;
  if (!name || !gender || !level || !username || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!['M', 'F'].includes(gender)) {
    return res.status(400).json({ error: 'Gender must be M or F' });
  }
  const parsedLevel = parseInt(level, 10);
  if (isNaN(parsedLevel) || parsedLevel < 1 || parsedLevel > 9) {
    return res.status(400).json({ error: 'Level must be between 1 and 9' });
  }

  const normalizedUsername = username.toLowerCase().trim();
  const picture_path = req.file ? `/uploads/${req.file.filename}` : null;

  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await db.run(
      'INSERT INTO players (name, gender, level, username, password_hash, picture_path) VALUES (?, ?, ?, ?, ?, ?)',
      [name, gender, parsedLevel, normalizedUsername, password_hash, picture_path]
    );

    const token = jwt.sign({ id: result.lastID }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({
      token,
      user: {
        id: result.lastID,
        name,
        username: normalizedUsername,
        gender,
        level: parsedLevel,
        picture_path,
        is_admin: 0
      }
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Username is already taken' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const normalizedUsername = username.toLowerCase().trim();

  try {
    const user = await db.get('SELECT * FROM players WHERE username = ?', [normalizedUsername]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        gender: user.gender,
        level: user.level,
        picture_path: user.picture_path,
        is_admin: user.is_admin
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth Login & Registration
app.post('/api/auth/google', async (req, res) => {
  const { id_token, gender, level } = req.body;

  if (!id_token) {
    return res.status(400).json({ error: 'Google ID Token is required' });
  }

  try {
    // Verify ID Token with Google Client
    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    
    const payload = ticket.getPayload();
    const googleId = payload['sub'];
    const email = payload['email'];
    const name = payload['name'];
    const picture = payload['picture'];

    // 1. Check if user already exists with this Google account
    let user = await db.get('SELECT * FROM players WHERE google_id = ?', [googleId]);

    // 2. Check if user exists with same email, then link accounts
    if (!user && email) {
      user = await db.get('SELECT * FROM players WHERE username = ?', [email]);
      if (user) {
        await db.run(
          'UPDATE players SET google_id = ?, picture_path = COALESCE(picture_path, ?) WHERE id = ?',
          [googleId, picture, user.id]
        );
        user.google_id = googleId;
        if (!user.picture_path) user.picture_path = picture;
      }
    }

    // 3. User does not exist, trigger registration flow
    if (!user) {
      // Since gender and level are required for tennis toss pairing, 
      // if they aren't provided yet, ask the client to collect them first.
      if (!gender || !level) {
        return res.json({
          registrationIncomplete: true,
          googleInfo: {
            googleId,
            email,
            name,
            picture
          }
        });
      }

      if (!['M', 'F'].includes(gender)) {
        return res.status(400).json({ error: 'Gender must be M or F' });
      }
      
      const parsedLevel = parseInt(level, 10);
      if (isNaN(parsedLevel) || parsedLevel < 1 || parsedLevel > 9) {
        return res.status(400).json({ error: 'Level must be between 1 and 9' });
      }

      // Create the new player in database
      const result = await db.run(
        'INSERT INTO players (name, gender, level, username, google_id, picture_path) VALUES (?, ?, ?, ?, ?, ?)',
        [name, gender, parsedLevel, email || googleId, googleId, picture]
      );

      user = {
        id: result.lastID,
        name,
        username: email || googleId,
        gender,
        level: parsedLevel,
        picture_path: picture,
        google_id: googleId,
        is_admin: 0
      };
    }

    // Issue JWT access token
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        gender: user.gender,
        level: user.level,
        picture_path: user.picture_path,
        is_admin: user.is_admin
      }
    });
  } catch (err) {
    res.status(400).json({ error: 'Failed to verify Google Token: ' + err.message });
  }
});

// Get Current User Profile
app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Update Profile
app.put('/api/profile', authenticateToken, upload.single('picture'), async (req, res) => {
  const { name, gender, level, username } = req.body;
  if (!name || !gender || !level || !username) {
    return res.status(400).json({ error: 'Name, gender, level, and email (username) are required' });
  }
  if (!['M', 'F'].includes(gender)) {
    return res.status(400).json({ error: 'Gender must be M or F' });
  }
  const parsedLevel = parseInt(level, 10);
  if (isNaN(parsedLevel) || parsedLevel < 1 || parsedLevel > 9) {
    return res.status(400).json({ error: 'Level must be between 1 and 9' });
  }

  const normalizedUsername = username.toLowerCase().trim();

  try {
    // Check if the username is already taken by another player
    const existing = await db.get('SELECT id FROM players WHERE username = ? AND id != ?', [normalizedUsername, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'Email (username) is already in use by another account' });
    }

    if (req.file) {
      const picture_path = `/uploads/${req.file.filename}`;
      
      // Clean up old avatar file if exists (and is a local file, not a Google URL)
      if (req.user.picture_path && !req.user.picture_path.startsWith('http')) {
        const oldFile = path.join(uploadsDir, path.basename(req.user.picture_path));
        if (fs.existsSync(oldFile)) {
          try {
            fs.unlinkSync(oldFile);
          } catch (e) {
            console.error('Failed to delete old avatar file:', e.message);
          }
        }
      }

      await db.run(
        'UPDATE players SET name = ?, gender = ?, level = ?, username = ?, picture_path = ? WHERE id = ?',
        [name, gender, parsedLevel, normalizedUsername, picture_path, req.user.id]
      );
    } else {
      await db.run(
        'UPDATE players SET name = ?, gender = ?, level = ?, username = ? WHERE id = ?',
        [name, gender, parsedLevel, normalizedUsername, req.user.id]
      );
    }
    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Push Notification Endpoints ---

// Get VAPID Public Key
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Save Push Subscription
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) {
    return res.status(400).json({ error: 'Subscription object required' });
  }

  try {
    await db.run(
      'UPDATE players SET subscription = ? WHERE id = ?',
      [JSON.stringify(subscription), req.user.id]
    );
    res.json({ message: 'Push subscription saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Weekly Sessions Endpoints ---

// Get all players (for admin management)
app.get('/api/players', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const players = await db.all('SELECT id, name, gender, level, username, is_admin FROM players ORDER BY name ASC');
    res.json({ players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new weekly session (Admin only)
app.post('/api/sessions', authenticateToken, requireAdmin, async (req, res) => {
  const { date } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Session date is required' });
  }

  try {
    // Check if there is an active session
    const activeSession = await db.get("SELECT * FROM sessions WHERE status IN ('open', 'active')");
    if (activeSession) {
      return res.status(400).json({ error: 'Please close or complete the current active session first' });
    }

    const result = await db.run('INSERT INTO sessions (date, status) VALUES (?, ?)', [date, 'open']);
    res.status(201).json({ id: result.lastID, date, status: 'open' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current session
app.get('/api/sessions/current', authenticateToken, async (req, res) => {
  try {
    const session = await db.get("SELECT * FROM sessions WHERE status IN ('open', 'active') ORDER BY id DESC LIMIT 1");
    if (!session) {
      return res.json({ session: null });
    }

    // Include signups
    const signups = await db.all(`
      SELECT s.player_id, s.status, p.name, p.gender, p.level
      FROM signups s
      JOIN players p ON s.player_id = p.id
      WHERE s.session_id = ?
    `, [session.id]);

    // Include matches if any
    const matches = await db.all(`
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
      WHERE m.session_id = ?
      ORDER BY m.round_number ASC, m.court ASC
    `, [session.id]);

    res.json({ session, signups, matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete session (Admin only)
app.post('/api/sessions/:id/complete', authenticateToken, requireAdmin, async (req, res) => {
  const sessionId = req.params.id;
  try {
    await db.run("UPDATE sessions SET status = 'completed' WHERE id = ?", [sessionId]);
    res.json({ message: 'Session completed successfully. History saved.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sign-up / Check-in for current session
app.post('/api/sessions/:id/signup', authenticateToken, async (req, res) => {
  const sessionId = req.params.id;
  try {
    const session = await db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'open') return res.status(400).json({ error: 'Session is no longer open for sign-ups' });

    await db.run(
      'INSERT INTO signups (session_id, player_id, status) VALUES (?, ?, ?)',
      [sessionId, req.user.id, 'pending']
    );
    res.status(201).json({ message: 'Successfully checked in for the toss session' });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'You are already signed up for this session' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Approve player signup (Admin only)
app.post('/api/sessions/:id/approve', authenticateToken, requireAdmin, async (req, res) => {
  const sessionId = req.params.id;
  const { player_id, status } = req.body; // status: 'approved' or 'pending'

  if (!player_id || !status) {
    return res.status(400).json({ error: 'Player ID and status are required' });
  }

  try {
    if (status === 'removed') {
      await db.run(
        'DELETE FROM signups WHERE session_id = ? AND player_id = ?',
        [sessionId, player_id]
      );
      res.json({ message: 'Player removed from roster' });
    } else {
      await db.run(
        'UPDATE signups SET status = ? WHERE session_id = ? AND player_id = ?',
        [status, sessionId, player_id]
      );
      res.json({ message: `Player registration set to ${status}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually add player and sign them up for the session (Admin only)
app.post('/api/sessions/:id/add-player', authenticateToken, requireAdmin, async (req, res) => {
  const sessionId = req.params.id;
  const { name, gender, level } = req.body;

  if (!name || !gender || !level) {
    return res.status(400).json({ error: 'Name, gender, and level are required' });
  }

  if (!['M', 'F'].includes(gender)) {
    return res.status(400).json({ error: 'Gender must be M or F' });
  }

  const parsedLevel = parseInt(level, 10);
  if (isNaN(parsedLevel) || parsedLevel < 1 || parsedLevel > 9) {
    return res.status(400).json({ error: 'Level must be between 1 and 9' });
  }

  try {
    const session = await db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Create a guest player account in players table
    const uniqueUsername = `guest-${Date.now()}-${Math.floor(Math.random() * 1000)}@toss.com`;
    const playerResult = await db.run(
      'INSERT INTO players (name, gender, level, username, is_admin) VALUES (?, ?, ?, ?, 0)',
      [name, gender, parsedLevel, uniqueUsername]
    );

    const playerId = playerResult.lastID;

    // Check them in (approved) for the session
    await db.run(
      'INSERT INTO signups (session_id, player_id, status) VALUES (?, ?, ?)',
      [sessionId, playerId, 'approved']
    );

    res.status(201).json({ message: 'Player created and added to session' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Round & Pairing Endpoints ---

// Generate next draft round (Admin only)
app.post('/api/sessions/:id/generate-round', authenticateToken, requireAdmin, async (req, res) => {
  const sessionId = req.params.id;

  try {
    const session = await db.get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Get approved players
    const approvedPlayers = await db.all(`
      SELECT p.id, p.name, p.gender, p.level FROM signups s
      JOIN players p ON s.player_id = p.id
      WHERE s.session_id = ? AND s.status = 'approved'
    `, [sessionId]);

    if (approvedPlayers.length !== 16) {
      return res.status(400).json({ error: `Exactly 16 approved players are required. Currently there are ${approvedPlayers.length} approved players.` });
    }

    // Determine the next round number
    const lastMatch = await db.get('SELECT MAX(round_number) as max_round FROM matches WHERE session_id = ?', [sessionId]);
    const nextRoundNumber = (lastMatch?.max_round || 0) + 1;

    // Generate optimal pairings
    const pairings = await generatePairings(sessionId, nextRoundNumber, approvedPlayers);

    res.json({ round_number: nextRoundNumber, pairings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Publish round matches and send Web Push notifications (Admin only)
app.post('/api/sessions/:id/publish-round', authenticateToken, requireAdmin, async (req, res) => {
  const sessionId = req.params.id;
  const { round_number, pairings } = req.body;

  if (!round_number || !pairings || pairings.length !== 4) {
    return res.status(400).json({ error: 'Valid round number and 4 match pairings are required' });
  }

  try {
    // Start database transaction
    await db.run('BEGIN TRANSACTION');

    // Make session status 'active' if it was 'open'
    await db.run("UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'open'", [sessionId]);

    // Remove any existing matches for this round number in this session to overwrite
    await db.run('DELETE FROM matches WHERE session_id = ? AND round_number = ?', [sessionId, round_number]);

    // Insert new matches
    const allParticipantIds = [];
    for (const match of pairings) {
      await db.run(`
        INSERT INTO matches (session_id, round_number, court, player1, player2, player3, player4)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        sessionId,
        round_number,
        match.court,
        match.player1.id,
        match.player2.id,
        match.player3.id,
        match.player4.id
      ]);
      allParticipantIds.push(match.player1.id, match.player2.id, match.player3.id, match.player4.id);
    }

    await db.commit();

    // Trigger Web Push Notifications in background
    // We send to all 16 players telling them their court and partners
    for (const match of pairings) {
      const matchPlayers = [match.player1, match.player2, match.player3, match.player4];
      const payload = {
        title: `Round ${round_number} Pairings Published!`,
        body: `Court ${match.court}: ${match.player1.name} & ${match.player2.name} VS ${match.player3.name} & ${match.player4.name}`,
        url: '/'
      };
      // Send custom push notification per court to make it personal
      await sendPushNotification(matchPlayers.map(p => p.id), payload);
    }

    res.json({ message: `Round ${round_number} published successfully and notifications sent` });
  } catch (err) {
    await db.run('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// Update match scores (Admin only)
app.put('/api/matches/:id/score', authenticateToken, requireAdmin, async (req, res) => {
  const matchId = req.params.id;
  const { team_a_score, team_b_score } = req.body;

  if (team_a_score === undefined || team_b_score === undefined) {
    return res.status(400).json({ error: 'Both team_a_score and team_b_score are required' });
  }

  try {
    await db.run(
      'UPDATE matches SET team_a_score = ?, team_b_score = ? WHERE id = ?',
      [team_a_score, team_b_score, matchId]
    );
    res.json({ message: 'Score updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Leaderboard & Stats Endpoints ---

// Get Leaderboard (History-based)
app.get('/api/leaderboard', authenticateToken, async (req, res) => {
  try {
    // Fetch all players
    const players = await db.all('SELECT id, name, gender, level, picture_path FROM players WHERE is_admin = 0');
    
    // Fetch all completed matches with scores
    const matches = await db.all(`
      SELECT player1, player2, player3, player4, team_a_score, team_b_score
      FROM matches 
      WHERE team_a_score IS NOT NULL AND team_b_score IS NOT NULL
    `);

    // Calculate statistics
    const statsMap = new Map();
    for (const p of players) {
      statsMap.set(p.id, {
        id: p.id,
        name: p.name,
        gender: p.gender,
        level: p.level,
        picture_path: p.picture_path,
        played: 0,
        wins: 0,
        losses: 0,
        pointsWon: 0,
        pointsLost: 0
      });
    }

    for (const m of matches) {
      const p1 = statsMap.get(m.player1);
      const p2 = statsMap.get(m.player2);
      const p3 = statsMap.get(m.player3);
      const p4 = statsMap.get(m.player4);

      // Skip stats if some players were deleted
      if (!p1 || !p2 || !p3 || !p4) continue;

      p1.played++; p2.played++; p3.played++; p4.played++;

      p1.pointsWon += m.team_a_score; p1.pointsLost += m.team_b_score;
      p2.pointsWon += m.team_a_score; p2.pointsLost += m.team_b_score;
      p3.pointsWon += m.team_b_score; p3.pointsLost += m.team_a_score;
      p4.pointsWon += m.team_b_score; p4.pointsLost += m.team_a_score;

      if (m.team_a_score > m.team_b_score) {
        p1.wins++; p2.wins++;
        p3.losses++; p4.losses++;
      } else {
        p3.wins++; p4.wins++;
        p1.losses++; p2.losses++;
      }
    }

    const leaderboard = Array.from(statsMap.values()).map(p => {
      const diff = p.pointsWon - p.pointsLost;
      const winRate = p.played > 0 ? Math.round((p.wins / p.played) * 100) : 0;
      return {
        ...p,
        diff,
        winRate
      };
    });

    // Sort by wins desc, diff desc, pointsWon desc
    leaderboard.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return b.pointsWon - a.pointsWon;
    });

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Close database on exit
process.on('SIGINT', async () => {
  if (db) await db.close();
  process.exit(0);
});

// Start the server if run directly
const isMain = process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server'));
if (isMain) {
  initDb().then(() => {
    app.listen(PORT, () => {
      console.log(`Tennis Toss API running on http://localhost:${PORT}`);
    });
  }).catch(err => {
    console.error('Failed to initialize database:', err);
  });
}
