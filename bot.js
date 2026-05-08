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
        console.log("🚀 Запуск моніторингу (Версія: 3.5 Debug Mode)...");
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
        console.log(`- Пройшли фільтр: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Вихід.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    // Таймаут на запит тексту 10 сек
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(10000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 4000); 
                        console.log("✅ Текст завантажено.");
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет."); }
            }

            // Фіксована пауза 5 сек між новинами
            await new Promise(r => setTimeout(r, 5000));

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
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 35000))
                    ]);

                    if (!result || !result.response) throw new Error("EMPTY_RESPONSE");

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                chat_id: TELEGRAM_CHAT_ID, 
                                text: `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${response}`, 
                                parse_mode: 'HTML', 
                                disable_web_page_preview: true 
                            }),
                            signal: AbortSignal.timeout(8000)
                        });
                        console.log("📨 Надіслано.");
                    } else {
                        console.log("⏭️ AI SKIP.");
                    }
                    success = true;
                } catch (err) {
                    attempts++;
                    // Виводимо конкретну помилку для дебагу
                    console.error(`❌ Помилка AI (Спроба ${attempts}): ${err.message}`);

                    if (attempts < MAX_AI_ATTEMPTS && (err.message.includes("503") || err.message.includes("demand") || err.message === 'TIMEOUT')) {
                        // Фіксована пауза 12 сек при помилці
                        console.log(`⚠️ Очікуємо 12 сек перед ретраєм...`);
                        await new Promise(r => setTimeout(r, 12000));
                    } else {
                        success = true; // Вихід з циклу, якщо спроби вичерпано або помилка фатальна
                    }
                }
            }
        }
        console.log("✅ Роботу завершено.");
        process.exit(0);
    } catch (error) {
        console.error("💥 Критична помилка:", error);
        process.exit(1);
    }
}

run();
