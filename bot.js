const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Повертаємо стабільну ініціалізацію
const parser = new Parser({
    headers: {
        'User-Agent': 'InvestBot/1.0 (anton012@gmail.com)',
        'Accept': 'application/atom+xml, application/xml, text/xml'
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
const hasTicker = (text) => targetRegex.test(text);

async function run() {
    try {
        console.log("Starting monitor (v3.9 Stable Rollback)...");
        let allItems = [];

        for (const feedSource of FEEDS) {
            try {
                // Просто передаємо URL як рядок — це найбільш сумісний спосіб
                const feed = await parser.parseURL(feedSource.url);
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                console.log(`- ${feedSource.name}: fetched ${items.length} items`);
            } catch (e) {
                console.error(`- ${feedSource.name} Error:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            return pubDate > thirtyFiveMinsAgo && hasTicker(item.title + " " + (item.contentSnippet || ""));
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());
        console.log(`\nFiltered: ${uniqueItems.length} unique items for AI\n`);

        if (uniqueItems.length === 0) {
            console.log("No new events. Exit.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`Processing: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(10000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 4000); 
                    }
                } catch (e) { console.log("Snippet only used."); }
            }

            // Пауза між запитами до ШІ
            await new Promise(r => setTimeout(r, 6000));

            const prompt = `Ти — Senior інвестиційний аналітик. Проаналізуй новину. 
            Якщо вона НЕ стосується тікерів ${TARGET_TICKERS.join(', ')} — відповідай SKIP. 
            Використовуй HTML формат.

            🎯 <b>Головне:</b> [Суть без води]
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            🧠 <b>Аналіз:</b> [Вплив на ціну]
            📈 <b>Опціонний кут:</b> [IV та стратегія проста мова]
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;

            while (!success && attempts < 3) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 40000))
                    ]);

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
                        console.log("Sent to Telegram.");
                    } else {
                        console.log("AI skipped this item.");
                    }
                    success = true;
                } catch (err) {
                    attempts++;
                    console.error(`AI Attempt ${attempts} failed: ${err.message}`);
                    if (attempts < 3) await new Promise(r => setTimeout(r, 10000));
                    else success = true;
                }
            }
        }
        process.exit(0);
    } catch (error) {
        console.error("Critical:", error.message);
        process.exit(1);
    }
}

run();
