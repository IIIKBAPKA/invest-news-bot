const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Базовий парсер без специфічних заблокованих хедерів
const parser = new Parser();

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
    { 
        name: 'GoogleNews', 
        url: `https://news.google.com/rss/search?q=${encodeURIComponent(tickerQuery)}+when:1d&hl=en-US&gl=US`,
        headers: { 'User-Agent': 'Mozilla/5.0' }
    },
    { 
        name: 'SEC', 
        url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom',
        headers: { 
            'User-Agent': 'InvestBot/1.0 (anton012@gmail.com)',
            'Host': 'www.sec.gov'
        }
    } 
];

const targetRegex = new RegExp(`\\b(${TARGET_TICKERS.join('|')})\\b`, 'i');
const hasTicker = (text) => targetRegex.test(text);

async function run() {
    try {
        console.log("Starting monitor (v3.8 Final Clean)...");
        let allItems = [];
        let sourceStats = {};

        for (const feedSource of FEEDS) {
            try {
                await new Promise(r => setTimeout(r, 2000));
                // Передаємо хедери індивідуально для кожного джерела
                const feed = await parser.parseURL({
                    url: feedSource.url,
                    headers: feedSource.headers
                });
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                sourceStats[feedSource.name] = items.length;
            } catch (e) {
                console.error(`Source Error [${feedSource.name}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            return pubDate > thirtyFiveMinsAgo && hasTicker(item.title + " " + (item.contentSnippet || ""));
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\nSTATS:`);
        console.log(`- Total found: ${allItems.length}`);
        Object.keys(sourceStats).forEach(s => console.log(`  [${s}]: ${sourceStats[s]} fetched`));
        console.log(`- Filtered: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("No new events. Exit.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nProcessing [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(10000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 4000); 
                        console.log("Full text loaded.");
                    }
                } catch (e) { console.log("Snippet only."); }
            }

            await new Promise(r => setTimeout(r, 5000));

            const prompt = `Ти — Senior інвестиційний аналітик який читає надану новину і намагається з неї взяти все найважливіше і детально проаналізувати. 
            Якщо новина НЕ стосується тікерів ${TARGET_TICKERS.join(', ')} або вона неважлива — відповідай SKIP. Дотримуйся шаблону.

            КРОК 2: Сформуй звіт (HTML):
            🎯 <b>Головне:</b> [Суть без води]
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            🧠 <b>Аналіз:</b> [Вплив на ціну акції]
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
                        console.log("Sent.");
                    } else { console.log("AI SKIP."); }
                    success = true;
                } catch (err) {
                    attempts++;
                    console.error(`AI Error (Attempt ${attempts}): ${err.message}`);
                    if (attempts < 3) await new Promise(r => setTimeout(r, 10000));
                    else success = true;
                }
            }
        }
        process.exit(0);
    } catch (error) {
        console.error("Critical Error:", error.message);
        process.exit(1);
    }
}

run();
