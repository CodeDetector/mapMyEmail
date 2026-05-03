const gmailService = require('./gmailService');
const supabaseService = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const knowledgeMapService = require('./knowledgeMapService');
const crypto = require('crypto');

// Sequential Worker Pool Pattern: 
// 1. Independent processing per employee (Parallel)
// 2. Sequential processing for each employee's emails (Serial)


const extractEmail = (str) => {
    if (!str) return null;
    const match = str.match(/<([^>]+)>/) || [null, str];
    return match[1].trim().toLowerCase();
};

async function processIndividualEmail(email, record, tokens) {
    const currentEmployeeId = record.employee_id;
    const receiverAddress = extractEmail(email.deliveredTo || email.to);
    const senderAddress = extractEmail(email.from);

    console.log(`📧 Processing email for ${currentEmployeeId}: From ${senderAddress} to ${receiverAddress}`);

    // Resolve the "opposition"
    let otherSideEmail = (extractEmail(email.from) === (record.employees?.emailId)) 
        ? receiverAddress 
        : senderAddress;

    let oppositionId = await supabaseService.getEmployeeId(otherSideEmail);
    if (!oppositionId) oppositionId = await supabaseService.getIdByEmail(otherSideEmail, 'clients');
    if (!oppositionId) oppositionId = await supabaseService.getIdByEmail(otherSideEmail, 'suppliers');

    let mediaHash = null;
    let mediaUrl = null;

    if (email.attachments && email.attachments.length > 0) {
        try {
            const attachment = email.attachments[0];
            const buffer = await gmailService.getAttachment(tokens, email.id, attachment.id);
            mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
            const fileName = `gmail_${email.id}_${attachment.filename}`;
            const publicUrl = await supabaseService.uploadFile('artifacts', fileName, buffer, attachment.mimeType);
            if (publicUrl) mediaUrl = publicUrl;
        } catch (e) {
            console.warn(`⚠️ Attachment error for ${email.id}:`, e.message);
        }
    }

    const emailContext = `${senderAddress}|${receiverAddress}|${email.subject}|${email.body}|${email.timestamp}`;
    const fullHexHash = crypto.createHash('sha256').update(emailContext).digest('hex');
    const numericHash = BigInt('0x' + fullHexHash.substring(0, 15)).toString();

    const emailPayload = {
        sender: senderAddress,
        receiver: receiverAddress,
        message: `Subject: ${email.subject}\n\n${email.body}`,
        employeeId: currentEmployeeId,
        oppositionId: oppositionId,
        mediaHash: mediaHash,
        mediaUrl: mediaUrl,
        hash: numericHash,
        threadId: BigInt.asIntN(64, BigInt('0x' + email.threadId)).toString()
    };

    await supabaseService.logEmailToDatabase(emailPayload);

    // Flag this employee's knowledge map for rebuild
    await supabaseService.markKnowledgeMapDirty(currentEmployeeId);

    await intelligenceService.processMessageForGraph(
        `Subject: ${email.subject}\n\n${email.body}`,
        { messageId: `GMAIL-${email.id}`, sender: email.from }
    );
}

async function pollInboxForEmployee(record) {
    const { employee_id: currentEmployeeId, token_data: tokens } = record;
    console.log(`🔍 Polling inbox for Employee ID: ${currentEmployeeId}...`);

    try {
        const newEmails = await gmailService.listNewEmails(tokens);
        if (newEmails.length === 0) return;

        // SEQUENTIAL processing within one employee's task
        for (const email of newEmails) {
            await processIndividualEmail(email, record, tokens);
        }
    } catch (inboxErr) {
        console.error(`❌ Error polling inbox for employee ${currentEmployeeId}:`, inboxErr.message);
    }
}

async function connectToEmail() {
    console.log('📬 Starting Omni-Brain Sequential Worker Pool...');

    // Start the 15-minute knowledge map rebuild cycle
    knowledgeMapService.start();

    setInterval(async () => {
        try {
            // 1. Fetch all employees who have authenticated Gmail
            const authRecords = await supabaseService.getAuthenticatedEmployees('gmail');
            console.log(`🔍 Omni-Brain: Polling ${authRecords.length} enabled inboxes...`);

            // 2. Schedule INDEPENDENT tasks with concurrency limit
            const tasks = authRecords.map(record => pollInboxForEmployee(record));
            
            // Wait for all to complete before next cycle starts
            await Promise.all(tasks);
            console.log(`✅ Finished polling cycle for ${authRecords.length} inboxes.`);
            
        } catch (err) {
            console.error('❌ Omni-Brain Polling cycle error:', err.message);
        }
    }, 60000); 
}

if (require.main === module) {
    connectToEmail();
}

module.exports = { connectToEmail };
