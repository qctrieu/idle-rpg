// server.js
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname helper in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- Postgres connection pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g. postgres://user:pass@localhost:5432/dbname
  // ssl: { rejectUnauthorized: false }       // enable if needed
});

const app  = express();
const PORT = process.env.PORT || 3000;
// GET /api/admin/users
app.get('/api/admin/users', async (req, res) => {
  try {
    // 1) join Users ⇆ Saves
    const { rows } = await pool.query(`
      SELECT
        u.id,
        u.email,
        -- pull out top‐level keys from save_data JSON
        COALESCE((s.save_data->>'playerLevel')::int,  NULL) AS "playerLevel",
        COALESCE((s.save_data->>'xp')::float,         NULL) AS xp,
        COALESCE((s.save_data->>'gold')::int,         NULL) AS gold,
        COALESCE((s.save_data->>'crystals')::int,     NULL) AS crystals,
        COALESCE((s.save_data->>'stage')::int,        NULL) AS stage,
        s.updated_at
      FROM Users u
      LEFT JOIN Saves s ON s.user_id = u.id
      ORDER BY u.id
    `);

    res.json(rows);
  } catch (err) {
    console.error('Error in /api/admin/users', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// --- Middleware ---
app.use(cors());
app.use(express.json());                                       // for parsing JSON bodies
app.use(express.static(path.join(__dirname, 'public')));       // serve client files from /public

// --- REGISTER ---
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email & password required' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO Users(email,password)
       VALUES($1,$2)
       RETURNING id, email`,
      [email, hash]
    );
    const user = result.rows[0];
    res.status(201).json({
      userId:  user.id,
      email:   user.email,
      message: 'Registration successful'
    });
  } catch (e) {
    res.status(400).json({ error: e.detail || e.message });
  }
});

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { rows } = await pool.query(
      'SELECT id, password FROM Users WHERE email = $1',
      [email]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // sign a JWT
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'CHANGE_THIS_SECRET',
      { expiresIn: '7d' }
    );
    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SAVE GAME STATE ---
app.post('/api/save', async (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/, '');
  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET || 'CHANGE_THIS_SECRET');
    const data       = req.body; // expect your full game‐state JSON here

    await pool.query(
      `INSERT INTO Saves (user_id, save_data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET save_data = $2, updated_at = NOW()`,
      [userId, data]
    );

    res.json({ message: 'Game saved' });
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// --- LOAD GAME STATE ---
app.get('/api/save', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/, '');
  try {
    const { userId } = jwt.verify(token, process.env.JWT_SECRET || 'a very secret key');
    const { rows } = await pool.query(
      'SELECT save_data FROM Saves WHERE user_id = $1',
      [userId]
    );
    if (!rows.length) {
      // return 200 + empty JSON instead of 404
      return res.json({});
    }
    res.json(rows[0].save_data);
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
