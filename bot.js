const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Налаштування парсера з User-Agent (обов'язково для SEC)
const parser = new Parser({
    headers: {
        'User-Agent': 'InvestBot/1.0 (your-email@example.com)', // ВПИШИ СВОЮ ПОШТУ ТУТ
        'Accept': 'application/atom+xml, application/xml, text/xml',
    },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// МАСТЕР-СПИСОК ТІКЕРІВ
const TARGET_TICKERS = [
    "NVDA", "GOOG", "VST", "AAPL", "TSLA", "DASH", "NEE", "UBER", 
    "O", "CVX", "XOM", "ADBE", "AMZN", "1VOW3", "KO", "MSFT", 
    "NFLX", "META", "AMD", "SPY", "QQQ"
];

// Динамічно формуємо запит для Google News
const tickerQuery = TARGET_TICKERS.join("+OR+");

// Джерела новин (тільки топові фінансові/трейдерські ресурси + SEC)
const FEEDS = [
    `https://news.google.com/rss/search?q=(${tickerQuery})+AND+(site:investing.com+OR+site:marketwatch.com+OR+site:benzinga.com+OR+site:barrons.com+OR+site:thefly.com)+when:1d&hl=en-US&gl=US`,
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' 
];

async function run() {
    try {
        console.log("Запуск перевірки новин та SEC документів...");
        let allItems = [];

        // Збираємо новини з усіх джерел
        for (const url of FEEDS) {
            try {
                const feed = await parser.parseURL(url);
                allItems = allItems.concat(feed.items);
            } catch (e) {
                console.error(`Помилка парсингу джерела:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        
        // Фільтрація
        const recentItems = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate).getTime();
            const titleUpper = item.title.toUpperCase();
            const contentUpper = (item.title + (item.contentSnippet || "")).toUpperCase();
            
            // Фільтруємо технічний спам від банків (структурні ноти 424B2)
            if (titleUpper.includes("424B2")) return false;

            // Перевіряємо, чи є в тексті хоча б один тікер з нашого масиву або слово MARKET
            const isTarget = TARGET_TICKERS.some(ticker => contentUpper.includes(ticker)) || contentUpper.includes("MARKET");
            
            // Логування пропущених через фільтр тікерів
            if (pubDate > thirtyFiveMinsAgo && !isTarget) {
                console.log(`[Фільтр тікерів] Пропущено (немає цільових компаній): ${item.title}`);
            }
            
            return pubDate > thirtyFiveMinsAgo && isTarget;
        });

        if (recentItems.length === 0) {
            console.log("Нових подій за останні 35 хвилин немає.");
            process.exit(0);
        }

        // Видаляємо дублікати за заголовком
        const uniqueItems = Array.from(new Map(recentItems.map(item => [item.title, item])).values());
        console.log(`Знайдено унікальних подій: ${uniqueItems.length}`);
        
        // Беремо перші 10 для обробки
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

            // Блок запиту до Gemini з повторними спробами
            while (attempt < maxAttempts) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
                    const result = await model.generateContent(prompt);
                    responseText = result.response.text().trim();
                    break;
                } catch (err) {
                    attempt++;
                    console.warn(`[Спроба ${attempt}] Помилка Gemini для "${item.title}": ${err.message}`);
                    if (attempt >= maxAttempts) {
                        responseText = "ERROR";
                    } else {
                        await new Promise(res => setTimeout(res, 10000));
                    }
                }
            }

            // Обробка відповідей SKIP та ERROR
            if (responseText.startsWith("SKIP")) {
                console.log(`[AI SKIP] Новина визнана неважливою: ${item.title}`);
                continue;
            }
            
            if (responseText === "ERROR") {
                console.log(`[API ERROR] Не вдалося отримати аналіз для: ${item.title}`);
                continue;
            }

            // Формування фінального повідомлення
            const message = `🔔 <b>Нова подія на ринку</b>\n📰 <a href="${item.link}">${item.title}</a>\n\n${responseText}`;

            // Відправка в Telegram
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
            
            // Логування результату відправки
            if (tgResponse.ok) {
                console.log(`[SUCCESS] Надіслано в Telegram: ${item.title}`);
            } else {
                console.error(`[TG ERROR] Помилка відправки: ${await tgResponse.text()}`);
            }
            
            // Затримка між відправками, щоб не зловити ліміт Telegram
            await new Promise(res => setTimeout(res, 3000));
        }
        
        console.log("----------\nРоботу завершено успішно!");
        process.exit(0);
        
    } catch (error) {
        console.error("Критична помилка в run():", error);
        process.exit(1);
    }
}

run();
