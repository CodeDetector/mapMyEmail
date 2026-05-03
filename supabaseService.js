const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

class SupabaseService {
    constructor() {
        if (!config.SUPABASE_URL || !config.SUPABASE_KEY) {
            console.error('❌ Supabase credentials missing in .env');
            this.client = null;
        } else {
            this.client = createClient(config.SUPABASE_URL, config.SUPABASE_KEY);
            console.log('✅ Supabase client initialized.');
        }
    }

    async getEmployeeId(sender) {
        if (!this.client) return null;
        try {
            let query = this.client.from('employees').select('id');
            if (sender.includes('@')) {
                const { data, error } = await query.eq('emailId', sender).single();
                if (error) return null;
                return data.id;
            } 
            const { data, error } = await query
                .or(`contact.eq.${sender},Mobile.eq.${sender}`)
                .single();
            if (error) return null;
            return data.id;
        } catch (err) {
            return null;
        }
    }

    async logEmailToDatabase(emailData) {
        if (!this.client) return;
        try {
            if (emailData.hash) {
                const { data: existing } = await this.client
                    .from('emails')
                    .select('id')
                    .eq('hash', emailData.hash)
                    .maybeSingle();
                if (existing) return;
            }
            await this.client
                .from('emails')
                .insert([{
                    sender: emailData.sender,
                    receiver: emailData.receiver,
                    message: emailData.message,
                    employeeId: emailData.employeeId,
                    oppositionId: emailData.oppositionId || null,
                    mediaHash: emailData.mediaHash || null,
                    mediaUrl: emailData.mediaUrl || null,
                    hash: emailData.hash || null,
                    threadId: emailData.threadId || null
                }]);
        } catch (err) {
            console.error('❌ logEmailToDatabase failed:', err.message);
        }
    }

    async getIdByEmail(email, table) {
        if (!this.client || !email) return null;
        try {
            const { data, error } = await this.client
                .from(table)
                .select('id')
                .eq('emailId', email)
                .single();
            if (error) return null;
            return data.id;
        } catch (err) {
            return null;
        }
    }

    async uploadFile(bucket, path, buffer, contentType) {
        if (!this.client) return null;
        try {
            const { error } = await this.client.storage
                .from(bucket)
                .upload(path, buffer, {
                    contentType: contentType,
                    upsert: true
                });
            if (error) return null;
            const { data } = this.client.storage.from(bucket).getPublicUrl(path);
            return data.publicUrl;
        } catch (err) {
            return null;
        }
    }

    async getAuthenticatedEmployees(provider = 'gmail') {
        if (!this.client || provider !== 'gmail') return [];
        try {
            const { data: secrets, error } = await this.client.rpc('get_all_gmail_secrets');
            if (error) throw error;
            const { data: statuses } = await this.client.from('employee_integrations').select('employee_id, is_enabled').eq('provider', provider);
            const enabledMap = {};
            if (statuses) statuses.forEach(s => enabledMap[s.employee_id] = s.is_enabled);
            return secrets
                .filter(record => enabledMap[record.employee_id] !== false)
                .map(record => ({ employee_id: record.employee_id, token_data: record.token_data }));
        } catch (err) {
            console.error(`❌ Vault Retrieval Error:`, err.message);
            return [];
        }
    }

    async upsertNode(type, name, properties = {}) {
        if (!this.client) return null;
        try {
            const { data: existing } = await this.client
                .from('nodes')
                .select('id')
                .eq('type', type)
                .eq('name', name)
                .maybeSingle();
            if (existing) {
                const { data: updated } = await this.client
                    .from('nodes')
                    .update({ properties: { ...existing.properties, ...properties }, updated_at: new Date() })
                    .eq('id', existing.id)
                    .select()
                    .single();
                return updated.id;
            }
            const { data: newNode, error: insertError } = await this.client
                .from('nodes')
                .insert([{ type, name, properties }])
                .select()
                .single();
            if (insertError) throw insertError;
            return newNode.id;
        } catch (err) {
            return null;
        }
    }

    async createEdge(fromNodeId, toNodeId, relationshipType, properties = {}) {
        if (!this.client || !fromNodeId || !toNodeId) return null;
        try {
            const { data, error } = await this.client
                .from('edges')
                .insert([{ from_node_id: fromNodeId, to_node_id: toNodeId, relationship_type: relationshipType, properties }])
                .select().single();
            if (error) throw error;
            return data.id;
        } catch (err) {
            return null;
        }
    }

    async getEmployees() {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client.from('employees').select('id, Name, Mobile, contact, emailId');
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('❌ getEmployees failed:', err.message);
            return [];
        }
    }

    // ─── Knowledge Map Methods ───────────────────────────────────

    async markKnowledgeMapDirty(employeeId) {
        if (!this.client || !employeeId) return;
        try {
            const { data: existing } = await this.client
                .from('knowledge_maps')
                .select('id')
                .eq('employee_id', employeeId)
                .maybeSingle();

            if (existing) {
                await this.client
                    .from('knowledge_maps')
                    .update({ is_dirty: true, updated_at: new Date().toISOString() })
                    .eq('id', existing.id);
            } else {
                await this.client
                    .from('knowledge_maps')
                    .insert([{ employee_id: employeeId, is_dirty: true, knowledge_map: {} }]);
            }
        } catch (err) {
            console.error(`❌ markKnowledgeMapDirty failed for ${employeeId}:`, err.message);
        }
    }

    async getDirtyKnowledgeMaps() {
        if (!this.client) return [];
        try {
            const { data, error } = await this.client
                .from('knowledge_maps')
                .select('id, employee_id, knowledge_map, last_rebuilt_at')
                .eq('is_dirty', true);
            if (error) throw error;
            return data || [];
        } catch (err) {
            console.error('❌ getDirtyKnowledgeMaps failed:', err.message);
            return [];
        }
    }

    async getNewInteractionsSince(employeeId, sinceTimestamp) {
        if (!this.client) return { messages: [], emails: [] };
        try {
            const since = sinceTimestamp || new Date(0).toISOString();

            const { data: messages, error: msgErr } = await this.client
                .from('messages')
                .select('description, created_at, messageType')
                .eq('employeeId', employeeId)
                .gte('created_at', since)
                .order('created_at', { ascending: true });
            if (msgErr) throw msgErr;

            const { data: emails, error: emailErr } = await this.client
                .from('emails')
                .select('sender, receiver, message, created_at')
                .eq('employeeId', employeeId)
                .gte('created_at', since)
                .order('created_at', { ascending: true });
            if (emailErr) throw emailErr;

            return { messages: messages || [], emails: emails || [] };
        } catch (err) {
            console.error(`❌ getNewInteractionsSince failed for ${employeeId}:`, err.message);
            return { messages: [], emails: [] };
        }
    }

    async saveKnowledgeMap(knowledgeMapId, knowledgeMapJson) {
        if (!this.client || !knowledgeMapId) return;
        try {
            const { error } = await this.client
                .from('knowledge_maps')
                .update({
                    knowledge_map: knowledgeMapJson,
                    is_dirty: false,
                    last_rebuilt_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', knowledgeMapId);
            if (error) throw error;
        } catch (err) {
            console.error(`❌ saveKnowledgeMap failed for ${knowledgeMapId}:`, err.message);
        }
    }
}

module.exports = new SupabaseService();
