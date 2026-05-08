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

// Спрощений пошук: просто наявність тікера в тексті
const isTargetCompany = (text) => {
    const upperText = text.toUpperCase();
    return TARGET_TICKERS.some(t => upperText.includes(t)) || upperText.includes("MARKET");
};

async function run() {
    try {
        console.log("🚀 Запуск фінального снайпер-бота...");
        let allItems = [];

        for (const feedSource of FEEDS) {
            try {
                const feed = await parser.parseURL(feedSource.url);
                allItems = allItems.concat(feed.items.map(i => ({ ...i, sourceName: feedSource.name })));
            } catch (e) {
                console.error(`❌ Помилка [${feedSource.name}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        let processedCount = 0;

        // Фільтруємо ТІЛЬКИ за часом та базовою наявністю тікера
        const filteredItems = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            return pubDate > thirtyFiveMinsAgo && isTargetCompany(item.title + " " + (item.contentSnippet || ""));
        });

        console.log(`✅ Знайдено ${filteredItems.length} потенційних новин за 35 хв.`);

        if (filteredItems.length === 0) {
            console.log("☕ Новин немає. Відпочиваємо.");
            process.exit(0);
        }

        // Видаляємо дублікати
        const uniqueItems = Array.from(new Map(filteredItems.map(item => [item.title, item])).values()).slice(0, 7);

        for (const item of uniqueItems) {
            processedCount++;
            console.log(`\n[${processedCount}] Аналізуємо: ${item.title}`);
            
            let fullContent = item.contentSnippet || item.description || "";
            
            // Спроба отримати повний текст через Jina
            try {
                const jinaUrl = `https://r.jina.ai/${item.link}`;
                const res = await fetch(jinaUrl);
                if (res.ok) {
                    const text = await res.text();
                    fullContent = text.slice(0, 10000);
                    console.log("   📄 Повний текст отримано.");
                }
            } catch (e) {
                console.log("   ⚠️ Тільки превью.");
            }

            const prompt = `Ти — Senior аналітик. Проаналізуй новину для трейдера опціонами.
            Якщо це не впливає на ринок або тікери ${TARGET_TICKERS.join(', ')} — пиши SKIP.
            Інакше дай звіт (HTML):
            🎯 <b>Суть:</b> ...
            🏢 <b>Тікери:</b> #TICKER
            📊 <b>Сентимент:</b> 🟢/🔴/🟡
            📈 <b>Стратегія:</b> (IV, Spreads, etc.)
            
            Текст: ${item.title} \n ${fullContent}`;

            try {
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Використовуємо 1.5 для стабільності лімітів
                const result = await model.generateContent(prompt);
                const response = result.response.text().trim();

                if (response.includes("SKIP")) {
                    console.log("   ⏭️ AI пропустив (неважливо).");
                    continue;
                }

                const message = `🔔 <b>Новина</b>\n<a href="${item.link}">${item.title}</a>\n\n${response}`;
                
                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    })
                });
                console.log("   ✅ Надіслано в TG!");
                await new Promise(r => setTimeout(r, 5000)); // Пауза для лімітів TG
            } catch (err) {
                console.error("   ❌ Помилка AI:", err.message);
            }
        }
    } catch (error) {
        console.error("Критична помилка:", error);
    }
}

run();
