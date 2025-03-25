// Required dependencies
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const moment = require('moment');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Set up file storage
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const roomId = req.params.roomId;
    const roomDir = path.join(uploadsDir, roomId);
    
    if (!fs.existsSync(roomDir)) {
      fs.mkdirSync(roomDir);
    }
    cb(null, roomDir);
  },
  filename: function (req, file, cb) {
    const uniqueFileName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueFileName);
  }
});

const upload = multer({ storage: storage });

// In-memory data store (replace with database in production)
const rooms = {};
const files = {};
const messages = {};

// Room cleanup scheduler (24 hour expiry)
function scheduleRoomCleanup(roomId) {
  setTimeout(() => {
    console.log(`Cleaning up room ${roomId}`);
    
    // Remove room data
    delete rooms[roomId];
    delete files[roomId];
    delete messages[roomId];
    
    // Remove room directory
    const roomDir = path.join(uploadsDir, roomId);
    if (fs.existsSync(roomDir)) {
      fs.rmSync(roomDir, { recursive: true, force: true });
    }
    
    // Notify any connected clients
    io.to(roomId).emit('roomExpired');
  }, 24 * 60 * 60 * 1000); // 24 hours
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to create a room
app.post('/api/rooms', (req, res) => {
  const { roomName, nickname } = req.body;
  const roomId = uuidv4().substring(0, 8);
  
  rooms[roomId] = {
    id: roomId,
    name: roomName || `Room #${roomId}`,
    createdAt: new Date().toISOString(),
    createdBy: nickname || 'Anonymous',
    users: {}
  };
  
  files[roomId] = [];
  messages[roomId] = [];
  
  // Schedule room cleanup
  scheduleRoomCleanup(roomId);
  
  res.json({
    success: true,
    roomId: roomId,
    roomName: rooms[roomId].name
  });
});

// API endpoint to check if a room exists
app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  
  if (rooms[roomId]) {
    res.json({
      success: true,
      roomName: rooms[roomId].name
    });
  } else {
    res.status(404).json({
      success: false,
      message: 'Room not found'
    });
  }
});

// API endpoint to upload a file
app.post('/api/rooms/:roomId/files', upload.array('files'), (req, res) => {
  const { roomId } = req.params;
  const { nickname } = req.body;
  
  if (!rooms[roomId]) {
    return res.status(404).json({
      success: false,
      message: 'Room not found'
    });
  }
  
  const uploadedFiles = req.files.map(file => {
    const fileId = uuidv4();
    const fileObj = {
      id: fileId,
      name: file.originalname,
      size: file.size,
      type: file.mimetype,
      path: file.path,
      uploadedBy: nickname || 'Anonymous',
      uploadedAt: new Date().toISOString()
    };
    
    files[roomId].push(fileObj);
    return fileObj;
  });
  
  // Broadcast file upload to all users in the room
  if (uploadedFiles.length > 0) {
    const message = {
      id: uuidv4(),
      sender: 'system',
      content: `${nickname || 'Anonymous'} shared ${uploadedFiles.length} file(s)`,
      timestamp: new Date().toISOString(),
      type: 'system',
      files: uploadedFiles
    };
    
    messages[roomId].push(message);
    io.to(roomId).emit('newMessage', message);
    io.to(roomId).emit('filesUploaded', uploadedFiles);
  }
  
  res.json({
    success: true,
    files: uploadedFiles
  });
});

// API endpoint to download a file
app.get('/api/rooms/:roomId/files/:fileId', (req, res) => {
  const { roomId, fileId } = req.params;
  
  if (!rooms[roomId]) {
    return res.status(404).json({
      success: false,
      message: 'Room not found'
    });
  }
  
  const file = files[roomId].find(f => f.id === fileId);
  
  if (!file) {
    return res.status(404).json({
      success: false,
      message: 'File not found'
    });
  }
  
  res.download(file.path, file.name);
});

// API endpoint to get all messages in a room
app.get('/api/rooms/:roomId/messages', (req, res) => {
  const { roomId } = req.params;
  
  if (!rooms[roomId]) {
    return res.status(404).json({
      success: false,
      message: 'Room not found'
    });
  }
  
  res.json({
    success: true,
    messages: messages[roomId]
  });
});

// API endpoint to get all files in a room
app.get('/api/rooms/:roomId/files', (req, res) => {
  const { roomId } = req.params;
  
  if (!rooms[roomId]) {
    return res.status(404).json({
      success: false,
      message: 'Room not found'
    });
  }
  
  res.json({
    success: true,
    files: files[roomId]
  });
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// Socket.IO events
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Join room
  socket.on('joinRoom', ({ roomId, nickname }) => {
    try {
      if (!rooms[roomId]) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      // Add user to room
      socket.join(roomId);
      rooms[roomId].users[socket.id] = {
        id: socket.id,
        nickname: nickname || 'Anonymous',
        joinedAt: new Date().toISOString()
      };
      
      // Send system message
      const message = {
        id: uuidv4(),
        sender: 'system',
        content: `${nickname || 'Anonymous'} joined the room`,
        timestamp: new Date().toISOString(),
        type: 'system'
      };
      
      messages[roomId].push(message);
      
      // Notify all users in the room
      io.to(roomId).emit('newMessage', message);
      io.to(roomId).emit('userJoined', { 
        userId: socket.id, 
        nickname: nickname || 'Anonymous',
        onlineCount: Object.keys(rooms[roomId].users).length
      });
      
      // Send room data to the new user
      socket.emit('roomData', {
        roomName: rooms[roomId].name,
        messages: messages[roomId],
        files: files[roomId],
        onlineCount: Object.keys(rooms[roomId].users).length
      });
    } catch (error) {
      console.error('Error in joinRoom:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });
  
  // Send message
  socket.on('sendMessage', ({ roomId, content }) => {
    if (!rooms[roomId] || !rooms[roomId].users[socket.id]) {
      socket.emit('error', { message: 'Room not found or you are not in this room' });
      return;
    }
    
    const user = rooms[roomId].users[socket.id];
    const message = {
      id: uuidv4(),
      sender: user.nickname,
      senderId: socket.id,
      content: content,
      timestamp: new Date().toISOString(),
      type: 'user'
    };
    
    messages[roomId].push(message);
    io.to(roomId).emit('newMessage', message);
  });
  
  // Leave room
  socket.on('leaveRoom', ({ roomId }) => {
    if (rooms[roomId] && rooms[roomId].users[socket.id]) {
      const user = rooms[roomId].users[socket.id];
      
      // Remove user from room
      delete rooms[roomId].users[socket.id];
      socket.leave(roomId);
      
      // Send system message
      const message = {
        id: uuidv4(),
        sender: 'system',
        content: `${user.nickname} left the room`,
        timestamp: new Date().toISOString(),
        type: 'system'
      };
      
      messages[roomId].push(message);
      
      // Notify all users in the room
      io.to(roomId).emit('newMessage', message);
      io.to(roomId).emit('userLeft', { 
        userId: socket.id, 
        nickname: user.nickname,
        onlineCount: Object.keys(rooms[roomId].users).length
      });
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Check all rooms for this user
    Object.keys(rooms).forEach(roomId => {
      if (rooms[roomId].users[socket.id]) {
        const user = rooms[roomId].users[socket.id];
        
        // Remove user from room
        delete rooms[roomId].users[socket.id];
        
        // Send system message
        const message = {
          id: uuidv4(),
          sender: 'system',
          content: `${user.nickname} left the room`,
          timestamp: new Date().toISOString(),
          type: 'system'
        };
        
        messages[roomId].push(message);
        
        // Notify all users in the room
        io.to(roomId).emit('newMessage', message);
        io.to(roomId).emit('userLeft', { 
          userId: socket.id, 
          nickname: user.nickname,
          onlineCount: Object.keys(rooms[roomId].users).length
        });
      }
    });
  });
});

// Export the server for serverless environments
module.exports = server;

// Start the server only if not in a serverless environment
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`ShareSpace server running on port ${PORT}`);
  });
}