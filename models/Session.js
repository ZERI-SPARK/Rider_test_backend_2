const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  // groupCode is used as the _id since it's the 6-character unique identifier
  _id: { type: String, required: true },
  leaderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['scheduled', 'active', 'completed'], default: 'active' },
  destination: { 
    lat: Number,
    lng: Number,
    name: String
  },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Session', SessionSchema);
