const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Використовуємо Google News для миттєвих оновлень. 
// Тут налаштований пошук новин за тікерами або загалом по ринку акцій за останню добу (when:1d)
const RSS_URL = 'https://news.google.com/rss/search?q=NVDA+OR+GOOG+OR+VST+OR+"stock+market"+when:1d&hl=en-US&gl=US';

async function run() {
    try {
        console.log("Запуск перевірки новин...");
        const feed = await parser.parseURL(RSS_URL);
        
        console.log(`Всього знайдено новин: ${feed.items.length}`);
        
        // Повертаємо фільтр: беремо тільки ті новини, які вийшли за останні 35 хвилин
        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const recentItems = feed.items.filter(item => new Date(item.pubDate).getTime() > thirtyFiveMinsAgo);

        if (recentItems.length === 0) {
            console.log("Нових новин за останні 35 хвилин немає.");
            return;
        }

        console.log(`Знайдено свіжих новин: ${recentItems.length}`);

        // Щоб не заспамити канал, відправляємо максимум 3 найважливіші новини за один запуск
        const itemsToProcess = recentItems.slice(0, 3); 

        for (const item of itemsToProcess) {
            console.log(`Оброблюємо: ${item.title}`);
            const prompt = `Ти — професійний інвестиційний аналітик. Я надам тобі заголовок та опис новини.
            1. Зроби короткий підсумок (до 3-х тез).
            2. Оціни загальний вплив на ринок (Позитивний / Негативний / Нейтральний).
            3. Якщо згадуються конкретні компанії (особливо GOOG, NVDA, VST), виділи це.
            
            ВАЖЛИВО: Відповідай українською мовою. Не використовуй форматування Markdown (жодних зірочок чи решіток). Пиши звичайним простим текстом.
            
            Новина: ${item.title} — ${item.contentSnippet || item.description}`;

            const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
            const result = await model.generateContent(prompt);
            const response = result.response.text();

            const message = `📰 <b>${item.title}</b>\n\n${response}\n\n🔗 <a href="${item.link}">Джерело</a>`;

            const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            const tgResponse = await fetch(tgUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML'
                })
            });
            
            if (tgResponse.ok) {
                console.log("Успішно відправлено!");
            }
            
            // Робимо паузу 3 секунди між новинами, щоб Telegram не заблокував за швидкість
            await new Promise(res => setTimeout(res, 3000));
        }
        console.log("Роботу завершено!");
    } catch (error) {
        console.error("Помилка:", error);
    }
}

run();
