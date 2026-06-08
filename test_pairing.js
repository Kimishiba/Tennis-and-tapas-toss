import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { generatePairings, setDb, db } from './server.js';

async function runSimulation() {
  console.log('=== TENNIS TOSS PAIRING SIMULATION START ===\n');

  // 1. Initialize in-memory test database
  const testDb = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  // Create schema
  await testDb.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      gender TEXT CHECK(gender IN ('M', 'F')) NOT NULL,
      level INTEGER CHECK(level >= 1 AND level <= 9) NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      subscription TEXT,
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
      PRIMARY KEY (session_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      round_number INTEGER NOT NULL,
      court INTEGER NOT NULL,
      player1 INTEGER NOT NULL,
      player2 INTEGER NOT NULL,
      player3 INTEGER NOT NULL,
      player4 INTEGER NOT NULL,
      team_a_score INTEGER,
      team_b_score INTEGER
    );
  `);

  // Override db in server.js
  setDb(testDb);

  // 2. Create 16 players (8 M, 8 F) with various levels
  const mockPlayers = [
    { name: 'Arthur Pro', gender: 'M', level: 1, username: 'p1' },
    { name: 'Bob Mid', gender: 'M', level: 4, username: 'p2' },
    { name: 'Charlie Low', gender: 'M', level: 7, username: 'p3' },
    { name: 'David Beg', gender: 'M', level: 9, username: 'p4' },
    { name: 'Ethan Mid', gender: 'M', level: 5, username: 'p5' },
    { name: 'Frank Pro', gender: 'M', level: 2, username: 'p6' },
    { name: 'George Low', gender: 'M', level: 6, username: 'p7' },
    { name: 'Harry Mid', gender: 'M', level: 5, username: 'p8' },
    { name: 'Alice Pro', gender: 'F', level: 2, username: 'p9' },
    { name: 'Beatrice Mid', gender: 'F', level: 4, username: 'p10' },
    { name: 'Chloe Low', gender: 'F', level: 7, username: 'p11' },
    { name: 'Diana Beg', gender: 'F', level: 8, username: 'p12' },
    { name: 'Emma Mid', gender: 'F', level: 5, username: 'p13' },
    { name: 'Fiona Pro', gender: 'F', level: 1, username: 'p14' },
    { name: 'Grace Low', gender: 'F', level: 6, username: 'p15' },
    { name: 'Helen Mid', gender: 'F', level: 5, username: 'p16' }
  ];

  const playersInDb = [];
  for (const p of mockPlayers) {
    const res = await testDb.run(
      'INSERT INTO players (name, gender, level, username, password_hash) VALUES (?, ?, ?, ?, ?)',
      [p.name, p.gender, p.level, p.username, 'mockhash']
    );
    playersInDb.push({ id: res.lastID, ...p });
  }

  console.log(`Created ${playersInDb.length} players (8 Men, 8 Women, Levels 1-9) in test database.\n`);

  // 3. Simulate 3 weeks of play (each week has 3 rounds)
  const totalWeeks = 3;
  const roundsPerWeek = 3;

  for (let w = 1; w <= totalWeeks; w++) {
    console.log(`--- SIMULATING WEEK ${w} ---`);

    // Create session
    const sessRes = await testDb.run('INSERT INTO sessions (date, status) VALUES (?, ?)', [`Week ${w}`, 'open']);
    const sessionId = sessRes.lastID;

    // Sign up all 16 players
    for (const p of playersInDb) {
      await testDb.run('INSERT INTO signups (session_id, player_id, status) VALUES (?, ?, ?)', [sessionId, p.id, 'approved']);
    }

    // Run rounds
    for (let r = 1; r <= roundsPerWeek; r++) {
      console.log(`Generating pairings for Round ${r}...`);
      
      const pairings = await generatePairings(sessionId, r, playersInDb);
      
      console.log(`Round ${r} Pairings generated successfully:`);
      
      // Save round matches to DB to simulate them being played
      for (const match of pairings) {
        // Log pairings visually
        console.log(
          `  Court ${match.court}: [${match.player1.name} (L${match.player1.level}/${match.player1.gender}) & ${match.player2.name} (L${match.player2.level}/${match.player2.gender})] vs ` +
          `[${match.player3.name} (L${match.player3.level}/${match.player3.gender}) & ${match.player4.name} (L${match.player4.level}/${match.player4.gender})]`
        );

        await testDb.run(`
          INSERT INTO matches (session_id, round_number, court, player1, player2, player3, player4, team_a_score, team_b_score)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          sessionId,
          r,
          match.court,
          match.player1.id,
          match.player2.id,
          match.player3.id,
          match.player4.id,
          Math.floor(Math.random() * 3) + 4, // random winning scores (e.g. 4-6)
          Math.floor(Math.random() * 3) + 4
        ]);
      }
      console.log('');
    }

    // Complete session
    await testDb.run("UPDATE sessions SET status = 'completed' WHERE id = ?", [sessionId]);
  }

  // 4. STATISTICAL VALIDATION & AUDITS
  console.log('=== AUDITING ROTATION AND LEVEL CONSTRAINTS ===\n');

  // Load all matches
  const matches = await testDb.all('SELECT * FROM matches');

  // Map of partner pairs to count
  const partnersCount = new Map();
  // Map of opponent pairs to count
  const opponentsCount = new Map();
  // Partner gaps check
  let maxPartnerGapSeen = 0;
  let gapsAboveFour = 0;
  // Gender split categories
  let mixedDoublesCount = 0;
  let strictSameGenderCount = 0;
  let isolatedGenderCount = 0;

  for (const m of matches) {
    const p1 = playersInDb.find(p => p.id === m.player1);
    const p2 = playersInDb.find(p => p.id === m.player2);
    const p3 = playersInDb.find(p => p.id === m.player3);
    const p4 = playersInDb.find(p => p.id === m.player4);

    // Partners
    const pair1 = [p1.id, p2.id].sort().join(',');
    const pair2 = [p3.id, p4.id].sort().join(',');
    partnersCount.set(pair1, (partnersCount.get(pair1) || 0) + 1);
    partnersCount.set(pair2, (partnersCount.get(pair2) || 0) + 1);

    // Check Partner Gaps
    const gap1 = Math.abs(p1.level - p2.level);
    const gap2 = Math.abs(p3.level - p4.level);
    maxPartnerGapSeen = Math.max(maxPartnerGapSeen, gap1, gap2);
    if (gap1 > 4) gapsAboveFour++;
    if (gap2 > 4) gapsAboveFour++;

    // Opponents
    const opps = [
      [p1.id, p3.id].sort().join(','),
      [p1.id, p4.id].sort().join(','),
      [p2.id, p3.id].sort().join(','),
      [p2.id, p4.id].sort().join(',')
    ];
    for (const opp of opps) {
      opponentsCount.set(opp, (opponentsCount.get(opp) || 0) + 1);
    }

    // Gender breakdown
    const mCount = [p1.gender, p2.gender, p3.gender, p4.gender].filter(g => g === 'M').length;
    const fCount = [p1.gender, p2.gender, p3.gender, p4.gender].filter(g => g === 'F').length;

    if (mCount === 2 && fCount === 2) {
      if (p1.gender !== p2.gender && p3.gender !== p4.gender) {
        mixedDoublesCount++;
      } else {
        strictSameGenderCount++;
      }
    } else if (mCount === 4 || fCount === 4) {
      strictSameGenderCount++;
    } else {
      isolatedGenderCount++;
    }
  }

  // 1. Assert Partner Rotation: No two players should ever be partnered together more than once.
  let partnerRepetitions = 0;
  for (const [pair, count] of partnersCount.entries()) {
    if (count > 1) {
      partnerRepetitions++;
      const [id1, id2] = pair.split(',');
      const n1 = playersInDb.find(p => p.id === parseInt(id1)).name;
      const n2 = playersInDb.find(p => p.id === parseInt(id2)).name;
      console.error(`🚨 Violating partner rotation: ${n1} and ${n2} partnered ${count} times!`);
    }
  }

  console.log(`- Partner Repetitions: ${partnerRepetitions} (Target: 0)`);
  console.log(`- Max Partner Level Gap Observed: ${maxPartnerGapSeen} (Target limit <= 4 preferred, up to 8 max)`);
  console.log(`- Total partner pairs with level gap > 4: ${gapsAboveFour} (Should be minimized/0 unless forced)`);
  console.log(`- Mixed Doubles Courts (1M/1F vs 1M/1F): ${mixedDoublesCount} / ${matches.length} matches`);
  console.log(`- Same Gender or Split Team Courts (e.g. 2M vs 2F, 4M, 4F): ${strictSameGenderCount} / ${matches.length} matches`);
  console.log(`- Courts with isolated gender (3M/1F or 3F/1M): ${isolatedGenderCount} / ${matches.length} matches (Target: 0 or very low)`);

  console.log('\nOpponent Play Frequency Distribution:');
  const opponentFreqs = {};
  for (const count of opponentsCount.values()) {
    opponentFreqs[count] = (opponentFreqs[count] || 0) + 1;
  }
  console.log(opponentFreqs);

  if (partnerRepetitions === 0 && maxPartnerGapSeen <= 8 && isolatedGenderCount === 0) {
    console.log('\n✅ SIMULATION AND AUDITS COMPLETED SUCCESSFULLY! The rotating pairing algorithm meets all constraints perfectly.');
  } else {
    console.error('\n❌ AUDIT FAILS. Core constraints were violated. Review the output log details above.');
    process.exit(1);
  }

  await testDb.close();
}

runSimulation().catch(err => {
  console.error('Simulation crashed:', err);
  process.exit(1);
});
