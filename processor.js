const gmailService        = require('./gmailService');
const supabaseService     = require('./supabaseService');
const intelligenceService = require('./intelligenceService');
const knowledgeMapService = require('./knowledgeMapService');
const crypto              = require('crypto');

const extractEmail = (str) => {
    if (!str) return null;
    const match = str.match(/<([^>]+)>/) || [null, str];
    return match[1].trim().toLowerCase();
};

// ── Default handler (used when running the feeder standalone) ────────────────
// Mirrors the original behaviour: write to emails table + graph.
async function _defaultEmailHandler(parsedEmail) {
    await supabaseService.logEmailToDatabase(parsedEmail);
    await supabaseService.markKnowledgeMapDirty(parsedEmail.employeeId);
    await intelligenceService.processMessageForGraph(parsedEmail.message, {
        messageId: parsedEmail.messageId,
        sender:    parsedEmail.sender,
    });
}

// Module-level handler — replaced by wa-field-tracker at startup.
let _emailHandler = _defaultEmailHandler;

function setEmailHandler(fn) {
    _emailHandler = fn;
}

// ── Core parsing (no DB writes here) ─────────────────────────────────────────

async function processIndividualEmail(email, record, tokens) {
    const currentEmployeeId = record.employee_id;
    const receiverAddress   = extractEmail(email.deliveredTo || email.to);
    const senderAddress     = extractEmail(email.from);

    console.log(`📧 Parsing email for employee ${currentEmployeeId}: ${senderAddress} → ${receiverAddress}`);

    // Resolve opposition (employee / client / supplier on the other side)
    let otherSideEmail = extractEmail(email.from) === record.employees?.emailId
        ? receiverAddress
        : senderAddress;

    let oppositionId = await supabaseService.getEmployeeId(otherSideEmail);
    if (!oppositionId) oppositionId = await supabaseService.getIdByEmail(otherSideEmail, 'clients');
    if (!oppositionId) oppositionId = await supabaseService.getIdByEmail(otherSideEmail, 'suppliers');

    // Media attachment
    let mediaHash = null;
    let mediaUrl  = null;
    if (email.attachments && email.attachments.length > 0) {
        try {
            const attachment = email.attachments[0];
            const buffer     = await gmailService.getAttachment(tokens, email.id, attachment.id);
            mediaHash = crypto.createHash('sha256').update(buffer).digest('hex');
            const fileName = `gmail_${email.id}_${attachment.filename}`;
            mediaUrl = await supabaseService.uploadFile('artifacts', fileName, buffer, attachment.mimeType);
        } catch (e) {
            console.warn(`⚠️ Attachment error for ${email.id}:`, e.message);
        }
    }

    // Dedup hash
    const emailContext = `${senderAddress}|${receiverAddress}|${email.subject}|${email.body}|${email.timestamp}`;
    const fullHexHash  = crypto.createHash('sha256').update(emailContext).digest('hex');
    const numericHash  = BigInt('0x' + fullHexHash.substring(0, 15)).toString();

    const parsedEmail = {
        // intake (messages table) fields
        messageId:    `GMAIL-${email.id}`,
        format:       email.attachments?.length > 0 ? 'pdf' : 'text',
        messageDetails: `Subject: ${email.subject}\n\n${email.body}`,
        employeeId:   currentEmployeeId,
        mediaUrl,
        mediaHash,
        // email channel (emails table) fields
        sender:       senderAddress,
        receiver:     receiverAddress,
        message:      `Subject: ${email.subject}\n\n${email.body}`,
        oppositionId: oppositionId || null,
        hash:         numericHash,
        threadId:     BigInt.asIntN(64, BigInt('0x' + email.threadId)).toString(),
    };

    await _emailHandler(parsedEmail);
}

async function pollInboxForEmployee(record) {
    const { employee_id: currentEmployeeId, token_data: tokens } = record;
    console.log(`🔍 Polling inbox for employee ${currentEmployeeId}…`);
    try {
        const newEmails = await gmailService.listNewEmails(tokens);
        if (newEmails.length === 0) return;
        for (const email of newEmails) {
            await processIndividualEmail(email, record, tokens);
        }
    } catch (err) {
        console.error(`❌ Error polling inbox for employee ${currentEmployeeId}:`, err.message);
    }
}

async function connectToEmail() {
    console.log('📬 Starting Gmail worker pool…');
    knowledgeMapService.start();
    setInterval(async () => {
        try {
            const authRecords = await supabaseService.getAuthenticatedEmployees('gmail');
            console.log(`🔍 Polling ${authRecords.length} enabled inbox(es)…`);
            await Promise.all(authRecords.map(r => pollInboxForEmployee(r)));
            console.log(`✅ Polling cycle complete for ${authRecords.length} inbox(es).`);
        } catch (err) {
            console.error('❌ Polling cycle error:', err.message);
        }
    }, 60000);
}

if (require.main === module) {
    connectToEmail();
}

module.exports = { connectToEmail, setEmailHandler };
