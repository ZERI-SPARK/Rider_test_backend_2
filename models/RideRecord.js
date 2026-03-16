const mongoose = require('mongoose');

const RideRecordSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, ref: 'Session', required: true }, // References the groupCode
  route: [{
    latitude: Number,
    longitude: Number,
    timestamp: { type: Date, default: Date.now }
  }],
  distanceJoined: { type: Number, default: 0 },
  distanceLeft: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now },
  leftAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('RideRecord', RideRecordSchema);
