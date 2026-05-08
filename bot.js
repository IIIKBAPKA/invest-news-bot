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
        
        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const recentItems = feed.items.filter(item => new Date(item.pubDate).getTime() > thirtyFiveMinsAgo);

        if (recentItems.length === 0) {
            console.log("Нових новин за останні 35 хвилин немає.");
            process.exit(0);
        }

        console.log(`Знайдено свіжих новин: ${recentItems.length}`);
        
        // Збільшили ліміт обробки до 10 новин (щоб зачепити всі важливі)
        const itemsToProcess = recentItems.slice(0, 10); 

        for (const item of itemsToProcess) {
            console.log(`Оброблюємо: ${item.title}`);
            
            const prompt = `Ти — Senior інвестиційний аналітик та експерт з торгівлі опціонами. 
            Твоє завдання: відфільтрувати інформаційний шум і дати професійну вижимку подій.

            КРОК 1 (ФІЛЬТР): Оціни новину. Якщо це "вода", клікбейт, чутки без джерел, аналітика заради аналітики або просто щоденні незначні коливання цін — твоя відповідь має складатись рівно з одного слова: SKIP.

            КРОК 2: Якщо новина дійсно важлива (звіти, макроекономіка, M&A, інновації), сформуй звіт СУВОРО за цим HTML-шаблоном. Заповни дані в дужках [...]:

            🎯 <b>Головне:</b> [Сформуй найважливіше з опису цієї новини. Стисло і по суті]

            🏢 <b>Компанії:</b> [Тікери з хештегом: #NVDA, #GOOG, #VST тощо]
            📊 <b>Сентимент:</b> [🟢 Позитивний / 🔴 Негативний / 🟡 Нейтральний]
            🔥 <b>Важливість:</b> [Оцінка 1-10]/10

            🧠 <b>Аналіз:</b>
            [2-3 тези про вплив на акції в середньостроковій перспективі.]

            📈 <b>Опціонний кут (IV & Strategy):</b>
            [Оціни вплив на очікувану волатильність (IV). Чи є умови для продажу премії (Iron Condor, Credit Spreads) через очікуване падіння IV (IV Crush), чи подія створює умови для купівлі волатильності?]

            ⚔️ <b>Конкуренти:</b>
            [Хто може виграти чи програти? Тікери через #]

            ВАЖЛИВО: Не використовуй Markdown (* або #, окрім тікерів). Відповідай українською мовою.
            Новина: ${item.title} — ${item.contentSnippet || item.description}`;

            let responseText = "";
            let attempt = 0;
            const maxAttempts = 3;

            while (attempt < maxAttempts) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
                    const result = await model.generateContent(prompt);
                    responseText = result.response.text().trim();
                    break;
                } catch (err) {
                    attempt++;
                    console.warn(`Спроба ${attempt} невдала: ${err.message}`);
                    if (attempt >= maxAttempts) {
                        responseText = "ERROR"; // Маркер помилки
                    } else {
                        await new Promise(res => setTimeout(res, 10000));
                    }
                }
            }

            // МАГІЯ ФІЛЬТРАЦІЇ: Якщо ШІ сказав SKIP або впав — ігноруємо новину
            if (responseText.startsWith("SKIP") || responseText === "ERROR") {
                console.log(`Новина пропущена (Неважлива або помилка API): ${item.title}`);
                continue; 
            }

            // Якщо новина пройшла фільтр, формуємо красиве повідомлення
            const message = `📰 <a href="${item.link}">${item.title}</a>\n\n${responseText}`;

            const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
            const tgResponse = await fetch(tgUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true // Відключаємо величезне прев'ю посилання знизу, бо у нас і так є текст
                })
            });
            
            if (tgResponse.ok) {
                console.log("Успішно відправлено крутий звіт!");
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
