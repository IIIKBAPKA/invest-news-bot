const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'Anton Vereta (anton012@gmail.com)', 
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
        console.log("🚀 Запуск моніторингу (v3.7 Paid Tier Optimized)...");
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
        
        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            return pubDate > thirtyFiveMinsAgo && hasTicker(item.title + " " + (item.contentSnippet || ""));
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 СТАТИСТИКА:`);
        console.log(`- Всього знайдено: ${allItems.length}`);
        console.log(`- Унікальних для аналізу: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Завершуємо.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 8000);
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет."); }
            }

            await new Promise(r => setTimeout(r, 4000));

            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується тікерів: ${TARGET_TICKERS.join(', ')} або новина неважлива — відповідай SKIP.

            ВАЖЛИВО: Використовуй ТІЛЬКИ теги <b>, <i>, <a>, <code>, <s>, <u>. 
            ЗАБОРОНЕНО: <div>, <span>, <p>, <ul>, <li>, <br>, Markdown (**).

            🎯 <b>Головне:</b> [Суть події]
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            🧠 <b>Аналіз:</b> [Вплив на ціну]
            📈 <b>Опціонний кут:</b> [IV та стратегії]
            ⚔️ <b>Конкуренти:</b> [Тікери]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;
            const MAX_AI_ATTEMPTS = 6; 

            while (!success && attempts < MAX_AI_ATTEMPTS) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 40000))
                    ]);

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        // Очистка HTML для Telegram
                        const safeResponse = response.replace(/<\/?(?!(b|i|a|code|s|u)\b)[^>]+>/gi, '');
                        const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${safeResponse}`;
                        
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

                        if (tgRes.ok) {
                            console.log("📨 Надіслано в Telegram.");
                        } else {
                            const errData = await tgRes.json();
                            console.error(`❌ Помилка Telegram: ${errData.description}`);
                        }
                    } else {
                        console.log("⏭️ AI SKIP.");
                    }
                    success = true;
                } catch (err) {
                    attempts++;
                    if (err.message.includes("503") || err.message.includes("demand") || err.message === 'TIMEOUT') {
                        console.log(`⚠️ Помилка AI (Спроба ${attempts}/${MAX_AI_ATTEMPTS}). Негайний повтор...`);
                        
                        if (attempts === MAX_AI_ATTEMPTS) {
                            const fallbackMsg = `🔔 <b>Новина (Без аналізу):</b> <a href="${item.link}">${item.title}</a>\n\n<i>⚠️ AI сервіс тимчасово недоступний.</i>`;
                            await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: fallbackMsg, parse_mode: 'HTML' })
                            });
                            success = true; 
                        }
                    } else {
                        console.error("❌ Фатальна помилка:", err.message);
                        success = true; 
                    }
                }
            }
        }
        process.exit(0);
    } catch (error) {
        console.error("💥 Критична помилка:", error);
        process.exit(1);
    }
}

run();
