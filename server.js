require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Phase 8: Mongoose Models
const User = require('./models/User');
const SessionRecord = require('./models/Session');
const RideRecord = require('./models/RideRecord');
const HazardLog = require('./models/HazardLog');

const app = express();
app.use(cors());
app.use(express.json()); // Essential for REST APIs

// Phase 8: Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// ==========================================
// Phase 8: REST APIs for Authentication & History
// ==========================================

// Register Route
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.status(400).json({ error: 'User already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({ username, email, passwordHash });
    await user.save();

    const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { _id: user._id, username: user.username, email: user.email } });
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Login Route
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ token, user: { _id: user._id, username: user.username, email: user.email } });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Fetch Ride History
app.get('/api/rides/history', authenticateToken, async (req, res) => {
  try {
    const records = await RideRecord.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    console.error('History Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch ride history' });
  }
});

// Server Initialization
const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Memory store for active sessions
// Format: { 'groupId': { leaderSocketId: '...', destinationCoords: null, routeCoords: null, hasStartedNavigation: false, members: { 'socketId': { name, isLeader, ... } } } }
const activeSessions = {};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Phase 4 - Story 8 Fix: Restrict Random Group Code Entry
  socket.on('validate_session', (groupCode, callback) => {
    if (activeSessions[groupCode]) {
      callback({ isValid: true });
    } else {
      callback({ isValid: false, error: "Session does not exist." });
    }
  });

  // User joins a group map session
  socket.on('join_group', async (data) => {
    // data expected: { groupCode, name, isLeader, userId } // Phase 8 addition
    const { groupCode, name, isLeader, userId } = data;
    
    socket.join(groupCode);
    
    // Initialize session if it doesn't exist
    if (!activeSessions[groupCode]) {
      activeSessions[groupCode] = { 
        leaderSocketId: null, 
        destinationCoords: null,
        routeCoords: null,
        hasStartedNavigation: false,
        regroupPoint: null, // Phase 7: Story 13
        hazards: [], // Phase 7: Story 14
        members: {} 
      };

      // Phase 8: Save or lookup Session in DB
      try {
        if (isLeader && userId) {
            let sessionDoc = await SessionRecord.findById(groupCode);
            if (!sessionDoc) {
                sessionDoc = new SessionRecord({ _id: groupCode, leaderId: userId, status: 'active' });
                await sessionDoc.save();
            }
        }
      } catch(err) { console.error("DB Session Init Error", err); }
    }
    
    // Assign Leader status
    if (isLeader) {
      activeSessions[groupCode].leaderSocketId = socket.id;
    }

    // Phase 8: Initialize RideRecord
    let rideRecordId = null;
    try {
        if (userId) {
            const ride = new RideRecord({ userId, sessionId: groupCode });
            await ride.save();
            rideRecordId = ride._id;
        }
    } catch(err) { console.error("DB RideRecord Init Error", err); }
    
    // Add member to session with explicit location properties initializing at null
    activeSessions[groupCode].members[socket.id] = { 
       socketId: socket.id, 
       name: name,
       userId: userId, // Phase 8
       rideRecordId: rideRecordId, // Phase 8 
       isLeader: isLeader, 
       lat: null, 
       lng: null, 
       heading: 0 
    };
    
    // Track which group this socket belongs to for easy cleanup on disconnect
    socket.groupId = groupCode;
    
    console.log(`Socket ${socket.id} (${name}) joined group ${groupCode}`);
    
    // Broadcast the full updated member list to everyone in the room (Issue 2)
    io.to(groupCode).emit('group_members_update', Object.values(activeSessions[groupCode].members));
    
    // Phase 4 - Bug 1 Fix: Session State Sync
    // If navigation already started, let the late-joiner know so they can see destination and UI toggles
    if (activeSessions[groupCode].hasStartedNavigation) {
      socket.emit('session_sync', {
        destinationCoords: activeSessions[groupCode].destinationCoords,
        routeCoords: activeSessions[groupCode].routeCoords // Only relevant if rider wants to draw it later
      });
    }

    // Phase 7 - Sync Regroup Point & Hazards for late joiners
    if (activeSessions[groupCode].regroupPoint || activeSessions[groupCode].hazards.length > 0) {
      socket.emit('phase7_sync', {
        regroupPoint: activeSessions[groupCode].regroupPoint,
        hazards: activeSessions[groupCode].hazards
      });
    }
  });

  // Receive and broadcast location
  socket.on('update_location', async (data) => {
    // Expected data format: { groupId, userId, lat, lng, isLeader, heading }
    
    // Store latest location in memory for late-joiners
    if (activeSessions[data.groupId] && activeSessions[data.groupId].members[socket.id]) {
       const member = activeSessions[data.groupId].members[socket.id];
       member.lat = data.lat;
       member.lng = data.lng;
       member.heading = data.heading || 0;

       // Phase 8: Throttled push of route coordinate to DB
       if (member.rideRecordId && Math.random() < 0.1) {
          try {
             await RideRecord.findByIdAndUpdate(member.rideRecordId, {
                $push: { route: { latitude: data.lat, longitude: data.lng } }
             });
          } catch(e) {}
       }
    }
    
    socket.to(data.groupId).emit('location_updated', {
      socketId: socket.id,
      ...data
    });
  });

  // Phase 3 Fix: Leader Starts Navigation
  socket.on('start_navigation', async (data) => {
    // Expected data format: { groupId, destinationCoords, routeCoords }
    
    // Phase 4: Save navigation state in memory for late-joiners
    if (activeSessions[data.groupId]) {
      activeSessions[data.groupId].destinationCoords = data.destinationCoords;
      activeSessions[data.groupId].routeCoords = data.routeCoords;
      activeSessions[data.groupId].hasStartedNavigation = true;

      // Phase 8: DB persistence
      try {
         await SessionRecord.findByIdAndUpdate(data.groupId, {
            destination: { lat: data.destinationCoords.latitude, lng: data.destinationCoords.longitude, name: "Selected Destination" },
            startTime: Date.now(),
            status: 'active'
         });
      } catch(e) {}
    }
    
    socket.to(data.groupId).emit('navigation_started', data);
  });
  
  // Phase 4 - Story 2 Fix: Leader stops navigation
  socket.on('stop_navigation', async (data) => {
     if (activeSessions[data.groupId]) {
        activeSessions[data.groupId].destinationCoords = null;
        activeSessions[data.groupId].routeCoords = null;
        activeSessions[data.groupId].hasStartedNavigation = false;

        // Phase 8: Complete Session in DB
        try {
           await SessionRecord.findByIdAndUpdate(data.groupId, { status: 'completed', endTime: Date.now() });
        } catch(e) {}
     }
     socket.to(data.groupId).emit('navigation_stopped');
  });

  // ==========================================
  // Phase 7: Communication & Hazards
  // ==========================================

  // Story 12: Quick Chat Messages
  socket.on('quick_message', (data) => {
    // Bug 4 Fix: Emit to everyone including sender so the sender gets the Toast
    io.to(data.groupId).emit('quick_message_received', data);
  });

  // Story 13: Regroup Point Management
  socket.on('regroup_point_updated', (data) => {
    // Expected: { groupId, latitude, longitude }
    if (activeSessions[data.groupId]) {
      activeSessions[data.groupId].regroupPoint = { latitude: data.latitude, longitude: data.longitude };
    }
    socket.to(data.groupId).emit('regroup_point_updated', { latitude: data.latitude, longitude: data.longitude });
  });

  socket.on('regroup_point_removed', (data) => {
    if (activeSessions[data.groupId]) {
      activeSessions[data.groupId].regroupPoint = null;
    }
    socket.to(data.groupId).emit('regroup_point_removed');
  });

  // Story 14: Hazard Reporting
  socket.on('hazard_added', async (data) => {
    // Expected: { groupId, id, type, latitude, longitude, reportedBy, dbUserId } // Phase 8 addition
    if (activeSessions[data.groupId]) {
      activeSessions[data.groupId].hazards.push({
        id: data.id,
        type: data.type,
        latitude: data.latitude,
        longitude: data.longitude,
        reportedBy: data.reportedBy,
        timestamp: Date.now()
      });

      // Phase 8: DB Hazard persistence
      if (data.dbUserId) {
        try {
           const hazardDb = new HazardLog({
              type: data.type,
              location: { latitude: data.latitude, longitude: data.longitude },
              reportedBy: data.dbUserId,
              sessionId: data.groupId
           });
           await hazardDb.save();
        } catch(e) {}
      }
    }
    socket.to(data.groupId).emit('hazard_added', data);
  });

  socket.on('hazard_removed', (data) => {
    // Expected: { groupId, id }
    if (activeSessions[data.groupId]) {
      activeSessions[data.groupId].hazards = activeSessions[data.groupId].hazards.filter(h => h.id !== data.id);
    }
    socket.to(data.groupId).emit('hazard_removed', { id: data.id });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const groupId = socket.groupId;
    if (groupId && activeSessions[groupId]) {
       const session = activeSessions[groupId];
       
       // Phase 4 - Story 9 Fix: Session Lifecycle Management
       // DO NOT destroy session instantly. Leave it alive for remaining riders.
       delete session.members[socket.id];
       
       if (Object.keys(session.members).length === 0) {
         // Room is mathematically empty. Destroy the session entirely.
         console.log(`Group ${groupId} is empty. Destroying session.`);
         delete activeSessions[groupId];
       } else {
         // Room still has members. If Leader drops, they just become an offline leader.
         if (session.leaderSocketId === socket.id) {
            console.log(`Leader of group ${groupId} disconnected temporarily.`);
            // Note: We don't reassign leader. Wait for them to reconnect via Session Persistence.
         }
         
         // Tell everyone else the updated member list
         io.to(groupId).emit('group_members_update', Object.values(session.members));
       }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Socket server listening on port ${PORT}`);
  console.log(`Make sure your Expo app points to your computer's local IP address on this port.`);
});
