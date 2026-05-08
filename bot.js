const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Посилання на загальні фінансові новини (можна змінити)
const RSS_URL = 'https://finance.yahoo.com/news/rssindex';

async function run() {
    try {
        console.log("Запуск перевірки новин...");
        const feed = await parser.parseURL(RSS_URL);
        
        // Відбираємо новини лише за останні 35 хвилин, щоб не спамити
        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const recentItems = feed.items.filter(item => new Date(item.pubDate).getTime() > thirtyFiveMinsAgo);

        if (recentItems.length === 0) {
            console.log("Нових новин за останні 35 хвилин немає.");
            return;
        }

        // Обмежуємо кількість новин до 3-х за один запуск
        const itemsToProcess = recentItems.slice(0, 3); 

        for (const item of itemsToProcess) {
            const prompt = `Ти — професійний інвестиційний аналітик. Я надам тобі заголовок та опис новини.
            1. Зроби короткий підсумок (до 3-х тез).
            2. Оціни загальний вплив на ринок (Позитивний / Негативний / Нейтральний).
            3. Якщо згадуються конкретні компанії (особливо GOOG, NVDA, VST або інші великі гравці), виділи це.
            Мова відповіді: Українська.
            
            Новина: ${item.title} — ${item.contentSnippet || item.description}`;

            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            const message = `📰 **${item.title}**\n\n${response}\n\n🔗 [Джерело](${item.link})`;

            const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            await fetch(tgUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'Markdown'
                })
            });
            console.log(`Відправлено новину: ${item.title}`);
            
            // Пауза 2 секунди, щоб Telegram не заблокував за спам
            await new Promise(res => setTimeout(res, 2000));
        }
        console.log("Роботу завершено успішно!");
    } catch (error) {
        console.error("Виникла помилка під час виконання:", error);
    }
}

run();
