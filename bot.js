const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 
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

const tickerQuery = TARGET_TICKERS.join(" OR ");
const FEEDS = [
    { name: 'GoogleNews', url: `https://news.google.com/rss/search?q=${encodeURIComponent(tickerQuery)}+when:1d&hl=en-US&gl=US` },
    { name: 'SEC', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' } 
];

const targetRegex = new RegExp(`\\b(${TARGET_TICKERS.join('|')})\\b`, 'i');

const hasTicker = (text) => {
    return targetRegex.test(text);
};

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (Версія: 3.4 Extreme Stability)...");
        let allItems = [];
        let sourceStats = {};

        for (const feedSource of FEEDS) {
            try {
                const feed = await parser.parseURL(feedSource.url);
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                sourceStats[feedSource.name] = items.length;
            } catch (e) {
                console.error(`❌ Помилка джерела [${feedSource.name}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        let passedBySource = { GoogleNews: 0, SEC: 0 };

        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            const isFresh = pubDate > thirtyFiveMinsAgo;
            const isTarget = hasTicker(item.title + " " + (item.contentSnippet || ""));
            
            if (isFresh && isTarget) {
                passedBySource[item.sourceName]++;
                return true;
            }
            return false;
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 ДЕТАЛЬНА СТАТИСТИКА:`);
        console.log(`- Всього знайдено: ${allItems.length}`);
        Object.keys(sourceStats).forEach(s => console.log(`  [${s}]: ${sourceStats[s]} завантажено`));
        console.log(`- Пройшли фільтр (35хв + Тікер):`);
        Object.keys(passedBySource).forEach(s => console.log(`  [${s}]: ${passedBySource[s]} пройшло`));
        console.log(`- Унікальних для ШІ: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                    if (res.ok) {
                        const content = await res.text();
                        // ЗМЕНШЕНО ДО 2500 СИМВОЛІВ для стабільності на Free Tier
                        fullText = content.slice(0, 2500);
                        console.log("✅ Текст оптимізовано (2.5k).");
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет."); }
            }

            // ПАУЗА 8 СЕКУНД (Cool-down)
            await new Promise(r => setTimeout(r, 8000));

            const prompt = `Ти — Senior інвестиційний аналітик який читає надану новину і намагається з неї взяти все найважливіше і детально проаналізувати. 
            Якщо новина НЕ стосується тікерів ${TARGET_TICKERS.join(', ')} або ти думаєш що вона особливо неважлива для ринку — відповідай SKIP. Важливо зберігати при відповіді мені формат шаблону

            КРОК 2: Сформуй звіт СУВОРО за HTML-шаблоном (без Markdown):
            🎯 <b>Головне:</b> [Суть події. Опиши про що новина без води, але щоб була чітко зрозуміла суть]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡 - вплив на компанію]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Вплив на ціну акції, аналіз новини]
            
            📈 <b>Опціонний кут:</b> [IV та стратегія: Iron Condor, Spreads тощо тут можеш не прям професійними словами, я поки вчусь і розумію що таке опціони, але якщо дуже специфічні терміни - можу плутатись]
            
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів і вплив на них]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;
            const MAX_AI_ATTEMPTS = 3; 

            while (!success && attempts < MAX_AI_ATTEMPTS) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 45000))
                    ]);

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${response}`;
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
                            signal: AbortSignal.timeout(12000)
                        });
                        console.log("📨 Надіслано.");
                    } else {
                        console.log("⏭️ AI SKIP.");
                    }
                    success = true;
                } catch (err) {
                    attempts++;
                    if (err.message.includes("503") || err.message.includes("demand") || err.message === 'TIMEOUT') {
                        // ЕКСПОНЕНЦІАЛЬНЕ ОЧІКУВАННЯ: 30, 60 секунд
                        const waitTime = attempts * 30000;
                        console.log(`⚠️ Помилка AI (Спроба ${attempts}/${MAX_AI_ATTEMPTS}). Чекаємо ${waitTime/1000} сек...`);
                        await new Promise(r => setTimeout(r, waitTime));
                    } else {
                        console.error("❌ Помилка AI:", err.message);
                        success = true; 
                    }
                }
            }
        }
        console.log("✅ Роботу завершено успішно.");
        process.exit(0);
    } catch (error) {
        console.error("💥 Критична помилка виконання:", error);
        process.exit(1);
    }
}

run();
