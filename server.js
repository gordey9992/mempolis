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

// Middleware
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
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB лимит

// ========== БАЗА ДАННЫХ ==========
const db = new sqlite3.Database('database.sqlite');

// Создание таблиц
db.serialize(() => {
  // Пользователи
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    avatar TEXT,
    joinDate TEXT,
    rating INTEGER DEFAULT 0
  )`);
  
  // Подписки
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER,
    subscribed_to_id INTEGER,
    FOREIGN KEY(subscriber_id) REFERENCES users(id),
    FOREIGN KEY(subscribed_to_id) REFERENCES users(id)
  )`);
  
  // Мемы
  db.run(`CREATE TABLE IF NOT EXISTS memes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    image TEXT,
    caption TEXT,
    likes INTEGER DEFAULT 0,
    comments INTEGER DEFAULT 0,
    timestamp TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);
  
  // Видео
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
  
  // Аудио
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
  
  // Лента (Reels)
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
  
  // Лайки (для отслеживания, чтобы нельзя было лайкнуть дважды)
  db.run(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    content_type TEXT,
    content_id INTEGER,
    UNIQUE(user_id, content_type, content_id)
  )`);
});

// ========== API ЭНДПОИНТЫ ==========

// Регистрация
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

// Вход
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
    
    // Получаем количество подписчиков и подписок
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

// Получение профиля пользователя
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

// Подписаться / отписаться
app.post('/api/subscribe', (req, res) => {
  const { subscriber_id, subscribed_to_id } = req.body;
  
  if (subscriber_id === subscribed_to_id) {
    return res.status(400).json({ error: 'Нельзя подписаться на себя' });
  }
  
  // Проверяем, есть ли уже подписка
  db.get(`SELECT id FROM subscriptions WHERE subscriber_id = ? AND subscribed_to_id = ?`,
    [subscriber_id, subscribed_to_id], (err, sub) => {
      if (sub) {
        // Отписываемся
        db.run(`DELETE FROM subscriptions WHERE subscriber_id = ? AND subscribed_to_id = ?`,
          [subscriber_id, subscribed_to_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ subscribed: false });
          });
      } else {
        // Подписываемся
        db.run(`INSERT INTO subscriptions (subscriber_id, subscribed_to_id) VALUES (?, ?)`,
          [subscriber_id, subscribed_to_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ subscribed: true });
          });
      }
    }
  );
});

// Получить всех пользователей (для поиска)
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
  switch(type) {
    case 'meme': table = 'memes'; break;
    case 'video': table = 'videos'; break;
    case 'audio': table = 'audios'; break;
    case 'feed': table = 'feed'; break;
    default: return res.status(400).json({ error: 'Неизвестный тип' });
  }
  
  db.run(`INSERT INTO ${table} (user_id, url, caption, likes, comments, timestamp) VALUES (?, ?, ?, 0, 0, ?)`,
    [userId, fileUrl, caption, timestamp],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      // Увеличиваем рейтинг пользователя
      db.run(`UPDATE users SET rating = rating + 10 WHERE id = ?`, [userId]);
      
      // Уведомляем всех через WebSocket о новом контенте
      io.emit('new_content', { type, id: this.lastID, userId, fileUrl, caption, timestamp });
      
      res.json({ id: this.lastID, url: fileUrl, caption, type });
    }
  );
});

// Получение контента
app.get('/api/memes', (req, res) => {
  db.all(`SELECT m.*, u.username FROM memes m JOIN users u ON m.user_id = u.id ORDER BY m.id DESC`, (err, memes) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(memes);
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

// Лайк контента
app.post('/api/like', (req, res) => {
  const { userId, contentType, contentId } = req.body;
  
  // Проверяем, не лайкнул ли уже
  db.get(`SELECT id FROM likes WHERE user_id = ? AND content_type = ? AND content_id = ?`,
    [userId, contentType, contentId], (err, existing) => {
      if (existing) {
        // Убираем лайк
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
          
          // Получаем обновлённое количество лайков
          db.get(`SELECT likes FROM ${table} WHERE id = ?`, [contentId], (err, row) => {
            io.emit('like_updated', { contentType, contentId, likes: row.likes });
            res.json({ liked: false, likes: row.likes });
          });
        });
      } else {
        // Добавляем лайк
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
            // Увеличиваем рейтинг автора
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

// ========== WEB SOCKETS ==========
io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);
  
  socket.on('user_online', (userId) => {
    socket.userId = userId;
    io.emit('user_status', { userId, status: 'online' });
  });
  
  socket.on('disconnect', () => {
    if (socket.userId) {
      io.emit('user_status', { userId: socket.userId, status: 'offline' });
    }
    console.log('Пользователь отключился:', socket.id);
  });
});

// ========== ЗАПУСК СЕРВЕРА ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер МЕМПОЛИС запущен на http://localhost:${PORT}`);
});
