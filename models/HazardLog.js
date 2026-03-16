const mongoose = require('mongoose');

const HazardLogSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['Go Slow', 'Accident', 'Police Check', 'Roadblock'] },
  location: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true }
  },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sessionId: { type: String, ref: 'Session' }, // Optional link to the session where it was reported
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('HazardLog', HazardLogSchema);
