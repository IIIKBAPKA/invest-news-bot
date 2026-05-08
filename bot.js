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
    "CVX", "XOM", "ADBE", "AMZN", "1VOW3", "KO", "MSFT", 
    "NFLX", "META", "AMD", "SPY", "QQQ"
];

// CNBC Finance (якісні новини без жорсткого пейволу) + SEC
const FEEDS = [
    'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', 
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' 
];

const targetRegex = new RegExp(`\\b(${TARGET_TICKERS.join('|')})\\b`, 'i');

async function run() {
    try {
        console.log("Запуск перевірки новин (CNBC) та SEC документів...");
        let allItems = [];

        for (const url of FEEDS) {
            try {
                const feed = await parser.parseURL(url);
                allItems = allItems.concat(feed.items);
            } catch (e) {
                console.error(`Помилка парсингу джерела ${url}:`, e.message);
            }
        }

        // Зміни на (24 * 60 * 60 * 1000) для тесту за добу, або залиш 35 хвилин для крона
        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);    
        
        // Лічильники для "Рентгену"
        let skippedByTime = 0;
        let skippedByTicker = 0;

        const recentItems = allItems.filter(item => {
            // Перевіряємо, чи є дата. Якщо немає, ставимо 0, щоб новина відкинулась як стара
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            const titleUpper = (item.title || "").toUpperCase();
            const content = (item.title || "") + " " + (item.contentSnippet || "");
            
            if (titleUpper.includes("424B2")) return false;

            const isFresh = pubDate > thirtyFiveMinsAgo;
            const isTarget = targetRegex.test(content);
            
            // Якщо новина стара — плюсуємо лічильник часу і відкидаємо
            if (!isFresh) {
                skippedByTime++;
                return false;
            }
            
            // Якщо свіжа, але не про наш тікер — логуємо і відкидаємо
            if (!isTarget) {
                skippedByTicker++;
                console.log(`[Локальний Фільтр] Пропущено (немає цільових тікерів): ${item.title}`);
                return false;
            }

            return true;
        });

        // Виводимо красиву статистику
        console.log(`\n📊 Статистика парсингу:`);
        console.log(`- Всього завантажено з джерел: ${allItems.length}`);
        console.log(`- Відкинуто (старіші за наш час): ${skippedByTime}`);
        console.log(`- Відкинуто (немає наших тікерів): ${skippedByTicker}`);
        console.log(`- Пройшли далі для аналізу ШІ: ${recentItems.length}\n`);

        if (recentItems.length === 0) {
            console.log("Нових подій по портфелю немає. Завершуємо роботу.");
            process.exit(0);
        }

        const uniqueItems = Array.from(new Map(recentItems.map(item => [item.title, item])).values());
        console.log(`Знайдено унікальних подій: ${uniqueItems.length}. Починаємо обробку...`);
        
        const itemsToProcess = uniqueItems.slice(0, 5); 

        for (const item of itemsToProcess) {
            console.log(`----------\nОброблюємо: ${item.title}`);
            
            // МАГІЯ: Бот "читає" повну статтю за посиланням
            let fullArticleText = item.contentSnippet || item.description || "";
            console.log(`Завантажуємо повний текст статті...`);
            try {
                // r.jina.ai автоматично витягує чистий текст із будь-якого URL
                const pageResponse = await fetch(`https://r.jina.ai/${item.link}`);
                if (pageResponse.ok) {
                    const text = await pageResponse.text();
                    // Відрізаємо перші 8000 символів, щоб не перевантажити ліміти токенів ШІ
                    fullArticleText = text.slice(0, 8000); 
                    console.log(`Текст успішно завантажено!`);
                }
            } catch (err) {
                console.log(`[Попередження] Не вдалося завантажити сайт, аналізуємо короткий сніпет.`);
            }

            await new Promise(res => setTimeout(res, 4000));

            const prompt = `Ти — Senior інвестиційний аналітик та експерт з торгівлі опціонами. 

            КРОК 1 (ФІЛЬТР СУВОРОСТІ): 
            - Якщо новина не містить конкретики або це "вода" — відповідай: SKIP.
            - Форми SEC: Форма 4 (інсайдери), 8-K, 10-Q/K для моїх компаній — це завжди ВАЖЛИВО.

            КРОК 2: Сформуй звіт СУВОРО за HTML-шаблоном. Не використовуй Markdown (** чи *). Заповни дані в дужках [...]:

            🎯 <b>Головне:</b> [Суть події на основі повного тексту. Якщо це SEC — вкажи тип форми та хто здійснив дію]

            🏢 <b>Компанії:</b> [Тікери з хештегом]
            📊 <b>Сентимент:</b> [🟢 Позитивний / 🔴 Негативний / 🟡 Нейтральний]
            🔥 <b>Важливість:</b> [1-10]/10

            🧠 <b>Аналіз:</b>
            [Детальний аналіз на основі прочитаної статті. Як це вплине на ціну акції. Коротко і по суті.]

            📈 <b>Опціонний кут (IV & Strategy):</b>
            [Вплив на IV. Чи варто продавати премію (Iron Condor, Credit Spreads) чи купувати волатильність?]

            ⚔️ <b>Конкуренти:</b> [Хто з конкурентів може виграти/програти, вкажи тікери]

            ВАЖЛИВО: Відповідай українською мовою.
            Джерело: ${item.link}
            Повний текст новини/документа: ${fullArticleText}`;

            let responseText = "";
            let attempt = 0;
            const maxAttempts = 3;

            while (attempt < maxAttempts) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    const result = await model.generateContent(prompt);
                    responseText = result.response.text().trim();
                    break;
                } catch (err) {
                    attempt++;
                    console.warn(`[Спроба ${attempt}] Помилка Gemini: ${err.message}`);
                    if (attempt >= maxAttempts) {
                        responseText = "ERROR";
                    } else {
                        console.log(`[API Cooldown] Зачекаємо 20 секунд перед наступною спробою...`);
                        await new Promise(res => setTimeout(res, 20000));
                    }
                }
            }

            if (responseText.startsWith("SKIP")) {
                console.log(`[AI SKIP] Новина визнана неважливою ШІ: ${item.title}`);
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
