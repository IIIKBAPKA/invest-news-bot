const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        // ОФІЦІЙНА ВИМОГА SEC: Назва + Email. Це прибере 403 помилку.
        'User-Agent': 'InvestAnalyticsBot/1.0 (anton012@gmail.com)', 
        'Host': 'www.sec.gov',
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
        console.log("🚀 Запуск моніторингу (Версія: 3.7 Gemini 2.0 Flash Lite)...");
        let allItems = [];
        let sourceStats = {};

        for (const feedSource of FEEDS) {
            try {
                // Невелика затримка для SEC
                await new Promise(r => setTimeout(r, 2000));
                const feed = await parser.parseURL(feedSource.url);
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                sourceStats[feedSource.name] = items.length;
            } catch (e) {
                console.error(`❌ Помилка джерела [${feedSource.name}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            return pubDate > thirtyFiveMinsAgo && hasTicker(item.title + " " + (item.contentSnippet || ""));
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 СТАТИСТИКА:`);
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
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(10000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 4000); 
                        console.log("✅ Текст завантажено.");
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет."); }
            }

            await new Promise(r => setTimeout(r, 5000));

            const prompt = `Ти — Senior інвестиційний аналітик який читає надану новину і намагається з неї взяти все найважливіше і детально проаналізувати. 
            Якщо новина НЕ стосується тікерів ${TARGET_TICKERS.join(', ')} або ти думаєш що вона особливо неважлива для ринку — відповідай SKIP. Важливо зберігати при відповіді мені формат шаблону

            КРОК 2: Сформуй звіт СУВОРО за HTML-шаблоном (без Markdown):
            🎯 <b>Головне:</b> [Суть події. Опиши про що новина без води, але щоб була чітко зрозуміла суть]
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡 - вплив на компанію]
            🔥 <b>Важливість:</b> [1-10]/10
            🧠 <b>Аналіз:</b> [Вплив на ціну акції, аналіз новини]
            📈 <b>Опціонний кут:</b> [IV та стратегія: Iron Condor, Spreads тощо проста мова]
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів і вплив на них]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;
            const MAX_AI_ATTEMPTS = 3; 

            while (!success && attempts < MAX_AI_ATTEMPTS) {
                try {
                    // Встановлено Gemini 2.0 Flash Lite
                    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
                    
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 40000))
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
                    console.error(`❌ Помилка AI (Спроба ${attempts}): ${err.message}`);

                    if (attempts < MAX_AI_ATTEMPTS && (err.message.includes("503") || err.message.includes("demand") || err.message === 'TIMEOUT')) {
                        console.log(`⚠️ Чекаємо 12 сек...`);
                        await new Promise(r => setTimeout(r, 12000));
                    } else {
                        success = true; 
                    }
                }
            }
        }
        console.log("✅ Роботу завершено успішно.");
        process.exit(0);
    } catch (error) {
        console.error("
