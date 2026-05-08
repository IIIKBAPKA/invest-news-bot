const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const RSS_URL = 'https://finance.yahoo.com/news/rssindex';

async function run() {
    try {
        console.log("Запуск перевірки новин...");
        const feed = await parser.parseURL(RSS_URL);
        
        console.log(`Всього знайдено новин у стрічці: ${feed.items.length}`);
        if (feed.items.length > 0) {
            console.log(`Найсвіжіша новина в RSS датована: ${feed.items[0].pubDate}`);
        }

        // Для тесту збільшуємо вікно пошуку до 12 годин
        const timeWindow = Date.now() - (12 * 60 * 60 * 1000);
        const recentItems = feed.items.filter(item => new Date(item.pubDate).getTime() > timeWindow);

        if (recentItems.length === 0) {
            console.log("Нових новин за вказаний час немає.");
            return;
        }

        console.log(`Пройшли фільтр часу: ${recentItems.length} новин.`);

        // Беремо ТІЛЬКИ ОДНУ новину для тесту, щоб не заспамити канал
        const itemsToProcess = recentItems.slice(0, 1); 

        for (const item of itemsToProcess) {
            console.log(`Оброблюємо новину: ${item.title}`);
            const prompt = `Ти — професійний інвестиційний аналітик. Я надам тобі заголовок та опис новини.
            1. Зроби короткий підсумок (до 3-х тез).
            2. Оціни загальний вплив на ринок (Позитивний / Негативний / Нейтральний).
            3. Якщо згадуються конкретні компанії (особливо GOOG, NVDA, VST), виділи це.
            Мова відповіді: Українська.
            
            Новина: ${item.title} — ${item.contentSnippet || item.description}`;

            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            const message = `📰 **${item.title}**\n\n${response}\n\n🔗 [Джерело](${item.link})`;

            const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            const tgResponse = await fetch(tgUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'Markdown'
                })
            });
            
            if (tgResponse.ok) {
                console.log("Успішно відправлено в Telegram!");
            } else {
                console.error("Помилка відправки в Telegram:", await tgResponse.text());
            }
        }
        console.log("Роботу завершено успішно!");
    } catch (error) {
        console.error("Виникла помилка під час виконання:", error);
    }
}

run();
