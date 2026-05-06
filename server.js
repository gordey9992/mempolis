const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Создание папок для загрузок
const uploadDirs = ['uploads/memes', 'uploads/videos', 'uploads/audios', 'uploads/feed'];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads/';
    switch(req.body.type) {
      case 'meme': folder += 'memes/'; break;
      case 'video': folder += 'videos/'; break;
      case 'audio': folder += 'audios/'; break;
      case 'feed': folder += 'feed/'; break;
      default: folder += 'memes/';
    }
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database('database.sqlite');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    avatar TEXT,
    joinDate TEXT,
    rating INTEGER DEFAULT 0
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER,
    subscribed_to_id INTEGER,
    FOREIGN KEY(subscriber_id) REFERENCES users(id),
    FOREIGN KEY(subscribed_to_id) REFERENCES users(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS memes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    caption TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    timestamp TEXT,
    is_animated INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    caption TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    timestamp TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS audios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    caption TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    timestamp TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    caption TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    timestamp TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content_type TEXT,
    content_id INTEGER,
    UNIQUE(user_id, content_type, content_id)
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS online_users (
    user_id INTEGER PRIMARY KEY,
    last_seen INTEGER
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS meme_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meme_id INTEGER,
    viewer_id INTEGER,
    viewed_at INTEGER
  )`);
});

// Создание системного пользователя и добавление начальных мемов
db.get(`SELECT id FROM users WHERE id = 1`, (err, user) => {
  if (!user) {
    db.run(`INSERT INTO users (id, username, email, password, joinDate, rating) VALUES (1, 'system', 'system@mempolis.com', '', datetime('now'), 0)`);
  }
  
  db.get(`SELECT COUNT(*) as count FROM memes WHERE user_id = 1`, (err, row) => {
    if (row && row.count === 0) {
      const defaultMemes = [
        { url: "https://i.imgflip.com/30b1gx.jpg", caption: "Два штата - вечная классика! 🤣" },
        { url: "https://i.imgflip.com/1g8my4.jpg", caption: "Когда показываешь мем другу 😎" },
        { url: "https://i.imgflip.com/1bij.jpg", caption: "Ожидание vs Реальность 🎭" },
        { url: "https://i.imgflip.com/aqzqvu.jpg", caption: "Медаль для Обамы: На! Пасиба! 🏅" }
      ];
      
      defaultMemes.forEach(meme => {
        db.run(`INSERT INTO memes (user_id, url, caption, likes, comments, timestamp, is_animated) VALUES (1, ?, ?, 0, 0, ?, 0)`,
          [meme.url, meme.caption, new Date().toISOString()]
        );
      });
      console.log('✅ Добавлены начальные мемы в БД');
    }
  });
});

// ========== API ЭНДПОИНТЫ ==========

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const joinDate = new Date().toISOString();
  
  db.run(`INSERT INTO users (username, email, password, joinDate, rating) VALUES (?, ?, ?, ?, 0)`,
    [username, email, hashedPassword, joinDate],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          res.status(400).json({ error: 'Пользователь с таким именем или email уже существует' });
        } else {
          res.status(500).json({ error: err.message });
        }
      } else {
        res.json({ id: this.lastID, username, email, joinDate });
      }
    }
  );
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(400).json({ error: 'Неверный пароль' });
    }
    
    db.get(`SELECT COUNT(*) as subscribers FROM subscriptions WHERE subscribed_to_id = ?`, [user.id], (err, subCount) => {
      db.get(`SELECT COUNT(*) as subscriptions FROM subscriptions WHERE subscriber_id = ?`, [user.id], (err, subsCount) => {
        res.json({
          id: user.id,
          username: user.username,
          email: user.email,
          avatar: user.avatar,
          joinDate: user.joinDate,
          rating: user.rating,
          subscribers: subCount?.subscribers || 0,
          subscriptions: subsCount?.subscriptions || 0
        });
      });
    });
  });
});

app.get('/api/user/:id', (req, res) => {
  const userId = req.params.id;
  
  db.get(`SELECT id, username, avatar, joinDate, rating FROM users WHERE id = ?`, [userId], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    db.get(`SELECT COUNT(*) as subscribers FROM subscriptions WHERE subscribed_to_id = ?`, [userId], (err, subCount) => {
      db.get(`SELECT COUNT(*) as subscriptions FROM subscriptions WHERE subscriber_id = ?`, [userId], (err, subsCount) => {
        res.json({
          ...user,
          subscribers: subCount?.subscribers || 0,
          subscriptions: subsCount?.subscriptions || 0
        });
      });
    });
  });
});

app.post('/api/subscribe', (req, res) => {
  const { subscriber_id, subscribed_to_id } = req.body;
  
  if (subscriber_id === subscribed_to_id) {
    return res.status(400).json({ error: 'Нельзя подписаться на себя' });
  }
  
  db.get(`SELECT id FROM subscriptions WHERE subscriber_id = ? AND subscribed_to_id = ?`,
    [subscriber_id, subscribed_to_id], (err, sub) => {
      if (sub) {
        db.run(`DELETE FROM subscriptions WHERE subscriber_id = ? AND subscribed_to_id = ?`,
          [subscriber_id, subscribed_to_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ subscribed: false });
          });
      } else {
        db.run(`INSERT INTO subscriptions (subscriber_id, subscribed_to_id) VALUES (?, ?)`,
          [subscriber_id, subscribed_to_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ subscribed: true });
          });
      }
    }
  );
});

app.get('/api/users', (req, res) => {
  db.all(`SELECT id, username, avatar, rating FROM users ORDER BY rating DESC LIMIT 50`, (err, users) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(users);
  });
});

// Загрузка контента
app.post('/api/upload', upload.single('file'), (req, res) => {
  const { userId, caption, type } = req.body;
  const fileUrl = `/uploads/${type}s/${req.file.filename}`;
  const timestamp = new Date().toISOString();
  
  let table;
  let isAnimated = 0;
  
  if (type === 'meme' && req.file.mimetype.startsWith('video/')) {
    isAnimated = 1;
  }
  
  switch(type) {
    case 'meme': table = 'memes'; break;
    case 'video': table = 'videos'; break;
    case 'audio': table = 'audios'; break;
    case 'feed': table = 'feed'; break;
    default: return res.status(400).json({ error: 'Неизвестный тип' });
  }
  
  const insertSQL = table === 'memes' 
    ? `INSERT INTO ${table} (user_id, url, caption, likes, comments, timestamp, is_animated) VALUES (?, ?, ?, 0, 0, ?, ?)`
    : `INSERT INTO ${table} (user_id, url, caption, likes, comments, timestamp) VALUES (?, ?, ?, 0, 0, ?)`;
  
  const params = table === 'memes' 
    ? [userId, fileUrl, caption, timestamp, isAnimated]
    : [userId, fileUrl, caption, timestamp];
  
  db.run(insertSQL, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    
    db.run(`UPDATE users SET rating = rating + 10 WHERE id = ?`, [userId]);
    
    io.emit('new_content', { type, id: this.lastID, userId, fileUrl, caption, timestamp });
    
    res.json({ id: this.lastID, url: fileUrl, caption, type });
  });
});

// Получение контента
app.get('/api/memes', (req, res) => {
  db.all(`SELECT m.*, u.username FROM memes m JOIN users u ON m.user_id = u.id ORDER BY m.id DESC`, (err, memes) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(memes);
  });
});

app.get('/api/meme/:id', (req, res) => {
  const id = req.params.id;
  db.get(`SELECT m.*, u.username FROM memes m JOIN users u ON m.user_id = u.id WHERE m.id = ?`, [id], (err, meme) => {
    if (err || !meme) return res.status(404).json({ error: 'Мем не найден' });
    res.json(meme);
  });
});

app.get('/api/videos', (req, res) => {
  db.all(`SELECT v.*, u.username FROM videos v JOIN users u ON v.user_id = u.id ORDER BY v.id DESC`, (err, videos) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(videos);
  });
});

app.get('/api/audios', (req, res) => {
  db.all(`SELECT a.*, u.username FROM audios a JOIN users u ON a.user_id = u.id ORDER BY a.id DESC`, (err, audios) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(audios);
  });
});

app.get('/api/feed', (req, res) => {
  db.all(`SELECT f.*, u.username FROM feed f JOIN users u ON f.user_id = u.id ORDER BY f.id DESC`, (err, feed) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(feed);
  });
});

// Просмотры
app.post('/api/view', (req, res) => {
  const { memeId, userId } = req.body;
  if (memeId && userId) {
    db.run(`INSERT INTO meme_views (meme_id, viewer_id, viewed_at) VALUES (?, ?, ?)`,
      [memeId, userId, Date.now()]);
  }
  res.json({ success: true });
});

// Получение количества просмотров
app.get('/api/views/:memeId', (req, res) => {
  const memeId = req.params.memeId;
  db.get(`SELECT COUNT(*) as views FROM meme_views WHERE meme_id = ?`, [memeId], (err, row) => {
    res.json({ views: row?.views || 0 });
  });
});

// Лайк контента
app.post('/api/like', (req, res) => {
  const { userId, contentType, contentId } = req.body;
  
  db.get(`SELECT id FROM likes WHERE user_id = ? AND content_type = ? AND content_id = ?`,
    [userId, contentType, contentId], (err, existing) => {
      if (existing) {
        db.run(`DELETE FROM likes WHERE user_id = ? AND content_type = ? AND content_id = ?`,
          [userId, contentType, contentId]);
        
        let table;
        switch(contentType) {
          case 'meme': table = 'memes'; break;
          case 'video': table = 'videos'; break;
          case 'audio': table = 'audios'; break;
          case 'feed': table = 'feed'; break;
          default: return res.status(400).json({ error: 'Неверный тип' });
        }
        
        db.run(`UPDATE ${table} SET likes = likes - 1 WHERE id = ?`, [contentId], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          
          db.get(`SELECT likes FROM ${table} WHERE id = ?`, [contentId], (err, row) => {
            io.emit('like_updated', { contentType, contentId, likes: row.likes });
            res.json({ liked: false, likes: row.likes });
          });
        });
      } else {
        db.run(`INSERT INTO likes (user_id, content_type, content_id) VALUES (?, ?, ?)`,
          [userId, contentType, contentId]);
        
        let table;
        switch(contentType) {
          case 'meme': table = 'memes'; break;
          case 'video': table = 'videos'; break;
          case 'audio': table = 'audios'; break;
          case 'feed': table = 'feed'; break;
          default: return res.status(400).json({ error: 'Неверный тип' });
        }
        
        db.run(`UPDATE ${table} SET likes = likes + 1 WHERE id = ?`, [contentId], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          
          db.get(`SELECT likes FROM ${table} WHERE id = ?`, [contentId], (err, row) => {
            db.get(`SELECT user_id FROM ${table} WHERE id = ?`, [contentId], (err, content) => {
              if (content) {
                db.run(`UPDATE users SET rating = rating + 1 WHERE id = ?`, [content.user_id]);
              }
            });
            
            io.emit('like_updated', { contentType, contentId, likes: row.likes });
            res.json({ liked: true, likes: row.likes });
          });
        });
      }
    }
  );
});

// Онлайн пользователи
setInterval(() => {
  const now = Date.now();
  db.run(`DELETE FROM online_users WHERE last_seen < ?`, [now - 60000]);
}, 60000);

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);
  
  socket.on('user_online', (userId) => {
    socket.userId = userId;
    db.run(`INSERT OR REPLACE INTO online_users (user_id, last_seen) VALUES (?, ?)`, [userId, Date.now()]);
    db.all(`SELECT user_id FROM online_users`, (err, users) => {
      io.emit('online_count', { count: users.length });
    });
  });
  
  socket.on('disconnect', () => {
    if (socket.userId) {
      db.run(`DELETE FROM online_users WHERE user_id = ?`, [socket.userId]);
      db.all(`SELECT user_id FROM online_users`, (err, users) => {
        io.emit('online_count', { count: users.length });
      });
    }
    console.log('Пользователь отключился:', socket.id);
  });
});

// Telegram уведомление
async function sendTelegramNotification() {
    const TELEGRAM_BOT_TOKEN = '8611724589:AAFbdZ3xfEyI_fAR9MxsSBE1SMQYiURjJpk';
    const TELEGRAM_CHAT_ID = '-1003818101194';
    
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: 'Обнова! mempolis.onrender.com обновился!'
            })
        });
        console.log('✅ Уведомление отправлено в Telegram');
    } catch (error) {
        console.log('❌ Ошибка:', error.message);
    }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер МЕМПОЛИС запущен на порту ${PORT}`);
});

sendTelegramNotification();
