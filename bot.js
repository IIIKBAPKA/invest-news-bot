const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

const hasTicker = (text) => {
    const upperText = text.toUpperCase();
    return TARGET_TICKERS.some(t => upperText.includes(t));
};

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (Gemini 3.1 Flash Lite)...");
        let allItems = [];

        for (const feedSource of FEEDS) {
            try {
                const feed = await parser.parseURL(feedSource.url);
                allItems = allItems.concat(feed.items.map(i => ({ ...i, sourceName: feedSource.name })));
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
        console.log(`📊 Статистика: Знайдено ${allItems.length}, після фільтрів ${uniqueItems.length}`);

        if (uniqueItems.length === 0) {
            console.log("☕ Новин немає.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`);
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 8000);
                        console.log("✅ Текст завантажено.");
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет."); }
            }

            // ПАУЗА між новинами
            await new Promise(r => setTimeout(r, 4000));

            const prompt = `Ти — Senior інвестиційний аналітик який читає надану новину і намагається з неї взяти все найважливіше і детально проаналізувати. 
            Якщо новина НЕ стосується тікерів ${TARGET_TICKERS.join(', ')} або ти думаєш що вона особливо неважлива для ринку — відповідай SKIP.

            КРОК 2: Сформуй звіт СУВОРО за HTML-шаблоном (без Markdown):
            🎯 <b>Головне:</b> [Суть події. Тут потрібно щоб ти описав про що взагалі ця новина, без води, але щоб була чітко зрозуміла суть]
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡 - як новина вплине на данну компанію якої стосується]
            🔥 <b>Важливість:</b> [1-10]/10
            🧠 <b>Аналіз:</b> [Вплив на ціну акції. Тут так само без води потрібен аналіз новини від тебе, щоб було чітко зрозуміло що до чого]
            📈 <b>Опціонний кут:</b> [IV та стратегія: Iron Condor, Spreads тощо]
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів і як вплине на них коротко]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;

            while (!success && attempts < 2) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    const result = await model.generateContent(prompt);
                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${response}`;
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
                        });
                        console.log("📨 Надіслано.");
                    } else {
                        console.log("⏭️ AI SKIP.");
                    }
                    success = true;
                } catch (err) {
                    attempts++;
                    if (err.message.includes("503") || err.message.includes("demand")) {
                        console.log(`⚠️ 503 Помилка. Спроба ${attempts}/2. Чекаємо 15 сек...`);
                        await new Promise(r => setTimeout(r, 15000));
                    } else {
                        console.error("❌ Помилка AI:", err.message);
                        success = true; // Виходимо з циклу при інших помилках
                    }
                }
            }
        }
        console.log("✅ Всі новини опрацьовано.");
        process.exit(0); // Обов'язкове завершення, щоб GitHub не висів
    } catch (error) {
        console.error("💥 Критична помилка:", error);
        process.exit(1);
    }
}

run();
