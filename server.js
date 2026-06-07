require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';

app.post('/webhook', async (req, res) => {
    try {
        const { event, data } = req.body;

        console.log('📩 Evento recibido:', event);

        if (event === 'messages.upsert') {
            await processIncomingMessage(data);
        }

        if (event === 'messages.update') {
            await processMessageUpdate(data);
        }

        res.status(200).json({
            status: 'success',
            message: 'Webhook processado correctamente',
            event,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error en webhook:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

async function processIncomingMessage(message) {
    try {
        const { from, body, fromMe, id } = message;

        if (fromMe) return;

        console.log('📨 Nuevo mensaje entrante:', { from, body });

        const autoResponse = await generateAutoResponse(body, from);
        if (autoResponse) {
            await sendWhatsAppMessage(from, autoResponse);
        }

    } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
    }
}

async function processMessageUpdate(messageUpdate) {
    const { message, status } = messageUpdate;
    console.log('📊 Actualización de mensaje:', status);
}

async function sendWhatsAppMessage(phone, text) {
    try {
        const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendText`,
            {
                number: phone,
                textMessage: { text }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${EVOLUTION_API_KEY}`
                },
                timeout: 30000
            }
        );

        console.log('✅ Mensaje enviado por WhatsApp:', response.data);
    } catch (error) {
        console.error('❌ Error enviando WhatsApp (intento 1):', error.message);

        try {
            const altResponse = await axios.post(
                `${EVOLUTION_API_URL}/api/v1/message/sendText`,
                {
                    number: phone,
                    textMessage: { text }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${EVOLUTION_API_KEY}`
                    },
                    timeout: 30000
                }
            );
            console.log('✅ Mensaje enviado (vía fallback):', altResponse.data);
        } catch (altError) {
            console.error('❌ Fallback también falló:', altError.message);
        }
    }
}

async function generateAutoResponse(message, phone) {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.match(/hola|buenos|buenas|hi|hey/)) {
        return `🏥 *GENTEFARMA* - Tu Farmacia Virtual 💊

¡Hola! Bienvenido a Gentefarma 🎉

Soy tu asistente virtual y puedo ayudarte con:

🔍 Consultar productos y medicamentos
📦 Realizar pedidos
💰 Ver precios y disponibilidad
📍 Horarios y ubicación
👤 Hablar con un humano

¿En qué puedo ayudarte hoy?`;
    }

    if (lowerMsg.match(/producto|medicamento|farmacia/)) {
        return `📦 *PRODUCTOS DISPONIBLES*

Tenemos una amplia variedad de productos farmacéuticos:

💊 Medicamentos
🧴 Cuidado personal
🍎 Vitaminas y suplementos
👶 Productos infantiles
🩺 Material médico

¿Qué medicamento o producto necesitas?`;
    }

    if (lowerMsg.match(/gracias|hasta|adios/)) {
        return `👋 ¡Gracias por contactar a Gentefarma!
    Tu pedido será procesado en breve.
¿Hay algo más en lo que pueda ayudarte?`;
    }

    return `🤖 *Asistente Gentefarma*

No estoy seguro de entenderte. ¿Podrías aclararme?

¿En qué puedo ayudarte?
1️⃣ Consultar productos
2️⃣ Realizar pedido
3️⃣ Información general`;
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'gentefarma-webhook',
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Gentefarma Webhook Service running on port ${PORT}`);
});
