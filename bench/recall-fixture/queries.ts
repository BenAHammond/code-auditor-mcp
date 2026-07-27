const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
stmt.bind(userId).run();
