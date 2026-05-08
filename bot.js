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

// Твій портфель. Тепер ми передаємо його безпосередньо в мозок ШІ
const TARGET_TICKERS = [
    "NVDA", "GOOG", "VST", "AAPL", "TSLA", "DASH", "NEE", "UBER", 
    "CVX", "XOM", "ADBE", "AMZN", "1VOW3", "KO", "MSFT", 
    "NFLX", "META", "AMD", "SPY", "QQQ"
];

// Перейшли на професійне джерело (MarketWatch) + SEC
const FEEDS = [
    'https://feeds.marketwatch.com/marketwatch/topstories',
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' 
];

async function run() {
    try {
        console.log("Запуск перевірки новин (MarketWatch) та SEC документів...");
        let allItems = [];

        for (const url of FEEDS) {
            try {
                const feed = await parser.parseURL(url);
                allItems = allItems.concat(feed.items);
            } catch (e) {
                console.error(`Помилка парсингу джерела ${url}:`, e.message);
            }
        }

        // Для тестування можна поставити 24 години (24 * 60 * 60 * 1000)
        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);    
        
        const recentItems = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate).getTime();
            const titleUpper = item.title.toUpperCase();
            
            // Фільтруємо технічний спам від банків
            if (titleUpper.includes("424B2")) return false;

            // Більше ніяких regex для тікерів! Беремо всі свіжі новини.
            return pubDate > thirtyFiveMinsAgo;
        });

        if (recentItems.length === 0) {
            console.log("Нових подій за останні 35 хвилин немає.");
            process.exit(0);
        }

        const uniqueItems = Array.from(new Map(recentItems.map(item => [item.title, item])).values());
        console.log(`Знайдено унікальних подій для аналізу ШІ: ${uniqueItems.length}`);
        
        // Збільшили ліміт обробки, щоб ШІ міг перевірити більше новин
        const itemsToProcess = uniqueItems.slice(0, 15); 

        for (const item of itemsToProcess) {
            console.log(`----------\nОброблюємо: ${item.title}`);
            
            // Затримка ПЕРЕД запитом до ШІ (щоб не перевищити ліміт 15 запитів/хвилина на Free Tier)
            await new Promise(res => setTimeout(res, 4000));

            const prompt = `Ти — Senior інвестиційний аналітик та експерт з торгівлі опціонами. 
            Ось список акцій, за якими я слідкую: ${TARGET_TICKERS.join(', ')}.

            Твоє завдання: проаналізувати новину або документ SEC.

            КРОК 1 (ФІЛЬТР СУВОРОСТІ): 
            - Якщо новина НЕ стосується жодної компанії з мого списку І НЕ є критичною макроекономічною подією (ФРС, інфляція, ринок праці США) — відповідай лише одним словом: SKIP.
            - Якщо це просто щоденні незначні коливання, "вода" або загальна аналітика без конкретики — відповідай: SKIP.
            - Форми SEC: Форма 4 (інсайдери), 8-K, 10-Q/K для моїх компаній — це завжди ВАЖЛИВО.

            КРОК 2: Якщо новина дійсно важлива для мене, сформуй звіт СУВОРО за HTML-шаблоном. Не використовуй Markdown (** чи *). Заповни дані в дужках [...]:

            🎯 <b>Головне:</b> [Суть події. Якщо це SEC — вкажи тип форми та хто здійснив дію]

            🏢 <b>Компанії:</b> [Тікери: #NVDA, #GOOG, #SPY тощо]
            📊 <b>Сентимент:</b> [🟢 Позитивний / 🔴 Негативний / 🟡 Нейтральний]
            🔥 <b>Важливість:</b> [1-10]/10

            🧠 <b>Аналіз:</b>
            [Як це вплине на ціну. Коротко і по суті.]

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
                    // Використовуємо 2.0-flash (актуальна модель з високими лімітами)
                    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
                    const result = await model.generateContent(prompt);
                    responseText = result.response.text().trim();
                    break;
                } catch (err) {
                    attempt++;
                    console.warn(`[Спроба ${attempt}] Помилка Gemini: ${err.message}`);
                    if (attempt >= maxAttempts) {
                        responseText = "ERROR";
                    } else {
                        console.log(`[API Cooldown] Зачекаємо 60 секунд перед наступною спробою...`);
                        await new Promise(res => setTimeout(res, 60000));
                    }
                }
            }

            if (responseText.startsWith("SKIP")) {
                console.log(`[AI SKIP] Новина не про портфель або неважлива: ${item.title}`);
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
            
            // Невелика пауза після відправки, щоб Telegram не заблокував за спам
            await new Promise(res => setTimeout(res, 2000));
        }
        
        console.log("----------\nРоботу завершено успішно!");
        process.exit(0);
        
    } catch (error) {
        console.error("Критична помилка в run():", error);
        process.exit(1);
    }
}

run();
