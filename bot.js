const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const RSS_URL = 'https://news.google.com/rss/search?q=NVDA+OR+GOOG+OR+VST+OR+"stock+market"+when:1d&hl=en-US&gl=US';

async function run() {
    try {
        console.log("Запуск перевірки новин...");
        const feed = await parser.parseURL(RSS_URL);
        
        console.log(`Всього знайдено новин: ${feed.items.length}`);
        
        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const recentItems = feed.items.filter(item => new Date(item.pubDate).getTime() > thirtyFiveMinsAgo);

        if (recentItems.length === 0) {
            console.log("Нових новин за останні 35 хвилин немає.");
            process.exit(0);
        }

        console.log(`Знайдено свіжих новин: ${recentItems.length}`);
        const itemsToProcess = recentItems.slice(0, 3); 

        for (const item of itemsToProcess) {
            console.log(`Оброблюємо: ${item.title}`);
            const prompt = `Ти — експертний інвестиційний аналітик. Проаналізуй наступну новину та сформуй звіт.
            Використовуй виключно українську мову. НЕ використовуй зірочки (*), решітки (#) як форматування Markdown, лише чистий текст.

            Сформуй відповідь за таким планом:

            1. ТІКЕРИ ТА ЧАС:
            Вкажи тікери компаній з хештегом (наприклад, #NVDA, #GOOG). Якщо компаній декілька — перерахуй усі. 
            Час публікації новини: ${item.pubDate}.

            2. АНОТАЦІЯ:
            Стисло (2-3 речення) про що новина.

            3. АНАЛІЗ GEMINI:
            Твої 3 головні висновки з цієї події. Що це означає в довгостроковій перспективі?

            4. ВПЛИВ НА РИНОК:
            - Як це змінить ціну акції головної компанії?
            - Хто з конкурентів може постраждати або виграти від цієї новини? (назви конкретні імена бажано тікери напр. #NVDA).
            - Вплив на ринок/сектор у цілому (позитивний/негативний/нейтральний).

            5. РИЗИК ТА МОЖЛИВІСТЬ:
            Оціни рівень важливості новини від 1 до 10. На що інвестору варто звернути увагу прямо зараз?

            Новина для аналізу: ${item.title} — ${item.contentSnippet || item.description}`;

            let responseText = "";
            let attempt = 0;
            const maxAttempts = 3;

            // Блок Retry для стабільності API
            while (attempt < maxAttempts) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
                    const result = await model.generateContent(prompt);
                    responseText = result.response.text();
                    break; // Успіх, виходимо з циклу спроб
                } catch (err) {
                    attempt++;
                    console.warn(`Спроба ${attempt} запиту до ШІ невдала: ${err.message}`);
                    if (attempt >= maxAttempts) {
                        responseText = "⚠️ *Gemini API тимчасово перевантажений і не зміг проаналізувати новину. Прочитайте оригінал за посиланням нижче.*";
                    } else {
                        console.log("Чекаємо 10 секунд перед наступною спробою...");
                        await new Promise(res => setTimeout(res, 10000));
                    }
                }
            }

            const message = `📰 <b>${item.title}</b>\n\n${responseText}\n\n🔗 <a href="${item.link}">Джерело</a>`;

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
            } else {
                console.error("Помилка Telegram:", await tgResponse.text());
            }
            
            await new Promise(res => setTimeout(res, 3000));
        }
        
        console.log("Роботу завершено!");
        process.exit(0);
    } catch (error) {
        console.error("Помилка:", error);
        process.exit(1);
    }
}

run();
