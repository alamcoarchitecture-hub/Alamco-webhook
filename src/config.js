// Simple, editable rules and message texts.
module.exports = {
  // Replies are matched against the inbound text (lowercase, trimmed, punctuation removed)
  ownerAcceptWords: ['ok', 'okay', 'accept', 'accepted'],
  messages: {
    ownerAcceptedReply: 'Accepted.',
    clientInboundReply: 'Thank you',
    instructionAck: 'Thank you, we have received your instruction. We will review it and update you.',
  },
  rules: {
    // Auto-reply to the client when a special instruction arrives with a client phone
    ackClientOnInstruction: true,
    // Reply "Thank you" to any non-owner inbound WhatsApp message
    replyThankYouToClients: true,
    // Reply "Accepted." when owner sends ok/accept/accepted
    replyAcceptedToOwner: true,
  },
};
