const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'InvestBot/1.0 (your-email@example.com)', // ВПИШИ СВОЮ ПОШТУ ТУТ
        'Accept': 'application/atom+xml, application/xml, text/xml',
    },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TARGET_TICKERS = [
    "NVDA", "GOOG", "VST", "AAPL", "TSLA", "DASH", "NEE", "UBER", 
    "O", "CVX", "XOM", "ADBE", "AMZN", "1VOW3", "KO", "MSFT", 
    "NFLX", "META", "AMD", "SPY", "QQQ"
];

const tickerQuery = TARGET_TICKERS.join("+OR+");

const FEEDS = [
    `https://news.google.com/rss/search?q=(${tickerQuery})+AND+(site:investing.com+OR+site:marketwatch.com+OR+site:benzinga.com+OR+site:barrons.com+OR+site:thefly.com)+when:1d&hl=en-US&gl=US`,
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' 
];

// Створюємо регулярний вираз для пошуку ТОЧНИХ слів (щоб уникнути багу з літерою O)
const targetRegex = new RegExp(`\\b(${TARGET_TICKERS.join('|')}|MARKET)\\b`, 'i');

async function run() {
    try {
        console.log("Запуск перевірки новин та SEC документів...");
        let allItems = [];

        for (const url of FEEDS) {
            try {
                const feed = await parser.parseURL(url);
                allItems = allItems.concat(feed.items);
            } catch (e) {
                console.error(`Помилка парсингу джерела:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        
        const recentItems = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate).getTime();
            const titleUpper = item.title.toUpperCase();
            const content = item.title + " " + (item.contentSnippet || "");
            
            // Фільтруємо технічний спам від банків
            if (titleUpper.includes("424B2")) return false;

            // МАГІЯ REGEX: Шукаємо тільки окремі слова, а не частини слів
            const isTarget = targetRegex.test(content);
            
            if (pubDate > thirtyFiveMinsAgo && !isTarget) {
                // Вимкнув логування пропущених, щоб не спамило тисячами рядків від SEC
                // console.log(`[Фільтр тікерів] Пропущено: ${item.title}`);
            }
            
            return pubDate > thirtyFiveMinsAgo && isTarget;
        });

        if (recentItems.length === 0) {
            console.log("Нових подій за останні 35 хвилин немає.");
            process.exit(0);
        }

        const uniqueItems = Array.from(new Map(recentItems.map(item => [item.title, item])).values());
        console.log(`Знайдено унікальних подій: ${uniqueItems.length}`);
        
        const itemsToProcess = uniqueItems.slice(0, 10); 

        for (const item of itemsToProcess) {
            console.log(`----------\nОброблюємо: ${item.title}`);
            
            const prompt = `Ти — Senior інвестиційний аналітик та експерт з торгівлі опціонами. 
            Твоє завдання: проаналізувати новину або офіційний документ SEC.

            КРОК 1 (ФІЛЬТР): Якщо це несуттєва технічна новина, клікбейт або рутинний звіт, що не впливає на ціну — відповідай: SKIP.
            Особлива увага SEC Filings: Форма 4 (інсайдери), 8-K (важливі події), 10-Q/K (звіти) — це ВАЖЛИВО.

            КРОК 2: Сформуй звіт СУВОРО за HTML-шаблоном. Не використовуй Markdown (** чи *). Заповни дані в дужках [...]:

            🎯 <b>Головне:</b> [Суть події. Якщо це SEC — вкажи тип форми та хто здійснив дію]

            🏢 <b>Компанії:</b> [Тікери: #NVDA, #GOOG, #VST тощо]
            📊 <b>Сентимент:</b> [🟢 Позитивний / 🔴 Негативний / 🟡 Нейтральний]
            🔥 <b>Важливість:</b> [1-10]/10

            🧠 <b>Аналіз:</b>
            [Як це вплине на акції. Інсайдерська покупка — це часто бичачий сигнал, продаж — залежить від обсягу.]

            📈 <b>Опціонний кут (IV & Strategy):</b>
            [Вплив на IV. Чи варто продавати премію (Iron Condor, Credit Spreads) чи купувати волатильність?]

            ⚔️ <b>Конкуренти:</b> [Тікери через #]

            ВАЖЛИВО: Відповідай українською мовою.
            Джерело: ${item.link}
            Подія: ${item.title} — ${item.contentSnippet || item.description}`;

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
                    console.warn(`[Спроба ${attempt}] Помилка Gemini: ${err.message}`);
                    if (attempt >= maxAttempts) {
                        responseText = "ERROR";
                    } else {
                        // ЗБІЛЬШЕНО ПАУЗУ ДО 35 СЕКУНД для обходу ліміту 429
                        console.log(`Зачекаємо 35 секунд перед наступною спробою...`);
                        await new Promise(res => setTimeout(res, 35000));
                    }
                }
            }

            if (responseText.startsWith("SKIP")) {
                console.log(`[AI SKIP] Новина визнана неважливою: ${item.title}`);
                continue;
            }
            
            if (responseText === "ERROR") {
                console.log(`[API ERROR] Не вдалося отримати аналіз для: ${item.title}`);
                continue;
            }

            const message = `🔔 <b>Нова подія на ринку</b>\n📰 <a href="${item.link}">${item.title}</a>\n\n${responseText}`;

            const tgResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            });
            
            if (tgResponse.ok) {
                console.log(`[SUCCESS] Надіслано в Telegram: ${item.title}`);
            } else {
                console.error(`[TG ERROR] Помилка відправки: ${await tgResponse.text()}`);
            }
            
            // Збільшено паузу до 6 секунд між успішними обробками, щоб не дратувати API
            await new Promise(res => setTimeout(res, 6000));
        }
        
        console.log("----------\nРоботу завершено успішно!");
        process.exit(0);
        
    } catch (error) {
        console.error("Критична помилка в run():", error);
        process.exit(1);
    }
}

run();
