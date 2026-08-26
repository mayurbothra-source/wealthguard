const axios = require('axios');

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;

const whatsappService = {
  async sendMessage(to, text) {
    if (!WA_TOKEN || !PHONE_ID) {
      console.log(`📱 [Demo] WhatsApp → ${to}: ${text.substring(0, 100)}...`);
      return { status: 'demo', to, preview: text.substring(0, 100) };
    }
    try {
      const { data } = await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
        { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      return data;
    } catch (err) {
      console.error('WhatsApp API error:', err.response?.data || err.message);
      throw err;
    }
  },

  async sendTemplate(to, templateName, params) {
    if (!WA_TOKEN || !PHONE_ID) {
      console.log(`📱 [Demo] WhatsApp template → ${to}: ${templateName}`);
      return { status: 'demo' };
    }
    try {
      const { data } = await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp', to, type: 'template',
          template: {
            name: templateName, language: { code: 'en' },
            components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: p })) }]
          }
        },
        { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      return data;
    } catch (err) {
      console.error('WhatsApp template error:', err.response?.data || err.message);
      throw err;
    }
  }
};

module.exports = { whatsappService };
