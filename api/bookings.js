import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  // Global CORS headers for cross-origin access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    return res.status(500).json({ error: 'Database connection string not configured' });
  }

  const sql = neon(databaseUrl);

  try {
    // Ensure bookings table exists in PostgreSQL
    await sql`
      CREATE TABLE IF NOT EXISTS boardroom_bookings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        organizer TEXT NOT NULL,
        date TEXT NOT NULL,
        start_min INTEGER NOT NULL,
        end_min INTEGER NOT NULL,
        created_at BIGINT NOT NULL
      );
    `;

    // 1. GET: Fetch all bookings
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, title, organizer, date, start_min, end_min, created_at 
        FROM boardroom_bookings 
        ORDER BY date ASC, start_min ASC;
      `;
      const bookings = rows.map(r => ({
        id: r.id,
        title: r.title,
        organizer: r.organizer,
        date: r.date,
        start: Number(r.start_min),
        end: Number(r.end_min),
        createdAt: Number(r.created_at)
      }));
      return res.status(200).json({ bookings });
    }

    // 2. POST: Create a new booking with strict collision check
    if (req.method === 'POST') {
      const { title, organizer, date, start, end } = req.body || {};
      if (!title || !organizer || !date || start === undefined || end === undefined) {
        return res.status(400).json({ error: 'Missing required booking fields' });
      }

      const startMin = Number(start);
      const endMin = Number(end);

      if (endMin <= startMin) {
        return res.status(400).json({ error: 'End time must be after start time' });
      }

      // Strict interval overlap check in SQL: GREATEST(A, C) < LEAST(B, D)
      const conflicts = await sql`
        SELECT id, title, organizer, start_min, end_min 
        FROM boardroom_bookings 
        WHERE date = ${date} 
          AND GREATEST(start_min, ${startMin}) < LEAST(end_min, ${endMin})
        LIMIT 1;
      `;

      if (conflicts.length > 0) {
        const c = conflicts[0];
        return res.status(409).json({
          error: `Time conflict: already booked by ${c.organizer} ("${c.title}")`,
          conflict: {
            id: c.id,
            title: c.title,
            organizer: c.organizer,
            start: Number(c.start_min),
            end: Number(c.end_min)
          }
        });
      }

      const newId = 'b_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      await sql`
        INSERT INTO boardroom_bookings (id, title, organizer, date, start_min, end_min, created_at)
        VALUES (${newId}, ${title}, ${organizer}, ${date}, ${startMin}, ${endMin}, ${Date.now()});
      `;

      return res.status(201).json({ success: true, id: newId });
    }

    // 3. DELETE: Cancel / remove a booking
    if (req.method === 'DELETE') {
      let id = req.query.id;
      if (!id && req.body) {
        try {
          const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
          id = parsed.id;
        } catch(e) {}
      }

      if (!id) {
        return res.status(400).json({ error: 'Missing booking ID to cancel' });
      }

      await sql`DELETE FROM boardroom_bookings WHERE id = ${id};`;
      return res.status(200).json({ success: true, deletedId: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Database handler error:', error);
    return res.status(500).json({ error: error.message || 'Database error occurred' });
  }
}
