const gmailProcessor = require('./processor');
const gmailService   = require('./gmailService');

async function run() {
    console.log('📧 Starting OMNI-BRAIN: Gmail Container…');
    gmailProcessor.connectToEmail();
}

if (require.main === module) {
    run();
}

module.exports = {
    gmailService,
    gmailProcessor,
    run,
    setEmailHandler: gmailProcessor.setEmailHandler,
};
