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

// Широкий пошук для Google News
const tickerQuery = TARGET_TICKERS.join(" OR ");
const FEEDS = [
    { name: 'GoogleNews', url: `https://news.google.com/rss/search?q=${encodeURIComponent(tickerQuery)}+when:1d&hl=en-US&gl=US` },
    { name: 'SEC', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' } 
];

// Локальна перевірка наявності тікера (щоб не слати в ШІ зовсім ліві новини)
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

        // 1. Фільтр за часом та тікером
        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            return pubDate > thirtyFiveMinsAgo && hasTicker(item.title + " " + (item.contentSnippet || ""));
        });

        // 2. Дедуплікація за заголовком
        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`📊 Статистика: Знайдено ${allItems.length} подій, після фільтрів залишилось ${uniqueItems.length}`);

        if (uniqueItems.length === 0) {
            console.log("☕ Новин по портфелю за останні 35 хв немає.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            
            // Спроба отримати повний текст (тільки для новин)
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`);
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 8000);
                        console.log("✅ Повний текст завантажено.");
                    }
                } catch (e) {
                    console.log("⚠️ Не вдалося завантажити повний текст.");
                }
            }

            // ПАУЗА 4 сек, щоб не бити RPM ліміт
            await new Promise(r => setTimeout(r, 4000));

            const prompt = `Ти — Senior інвестиційний аналітик. 
            Проаналізуй новину для трейдера. Якщо вона НЕ стосується тікерів ${TARGET_TICKERS.join(', ')} — відповідай SKIP.
            
            Формат відповіді (HTML):
            🎯 <b>Суть:</b> [Коротко головне]
            🏢 <b>Тікери:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            📈 <b>Опціонний кут:</b> [Вплив на IV та ідея стратегії]

            Текст: ${item.title} \n ${fullText}`;

            try {
                // ПРАВИЛЬНА МОДЕЛЬ (3.1 Flash Lite)
                const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                const result = await model.generateContent(prompt);
                const response = result.response.text().trim();

                if (response.includes("SKIP")) {
                    console.log("⏭️ AI пропустив новину.");
                    continue;
                }

                const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${response}`;
                
                const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true
                    })
                });

                if (tgRes.ok) console.log("📨 Надіслано в Telegram.");
            } catch (err) {
                console.error("❌ Помилка AI:", err.message);
            }
        }
    } catch (error) {
        console.error("💥 Критична помилка:", error);
    }
}

run();
