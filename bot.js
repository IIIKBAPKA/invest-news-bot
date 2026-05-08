const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'InvestAnalyticsBot/1.0 (anton012@gmail.com)',
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

// Використовуємо регулярні вирази для точного пошуку тікерів як окремих слів
const targetRegex = new RegExp(`\\b(${TARGET_TICKERS.join('|')})\\b`, 'i');

const hasTicker = (item) => {
    const textToSearch = `${item.title} ${item.contentSnippet || item.description || ""}`;
    return targetRegex.test(textToSearch);
};

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (v3.2.7 - Custom Prompt Fixed)...");
        let allItems = [];
        let sourceStats = {};

        for (const feedSource of FEEDS) {
            try {
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
            return pubDate > thirtyFiveMinsAgo && hasTicker(item);
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 СТАТИСТИКА:`);
        console.log(`- Всього знайдено: ${allItems.length}`);
        Object.keys(sourceStats).forEach(s => console.log(`  [${s}]: ${sourceStats[s]} завантажено`));
        console.log(`- Пройшли фільтр: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Завершуємо.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            const newsContent = `Джерело: ${item.sourceName}\nЗаголовок: ${item.title}\nОпис: ${item.contentSnippet || item.description || "Опис відсутній"}`;

            await new Promise(r => setTimeout(r, 6000));

            // Твій промпт БЕЗ ЗМІН
            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується тікерів: ${TARGET_TICKERS.join(', ')} або ти вважаєш що вона неважлива — відповідай SKIP. Важливо збережи структуру шаблону

            ВАЖЛИВО: Використовуй ТІЛЬКИ теги <b>, <i>, <a>, <code>. 
            ЗАБОРОНЕНО використовувати <div>, <span>, <p>, <ul>, <li>.

            КРОК 2: Сформуй звіт СУВОРО за шаблоном:
            🎯 <b>Головне:</b> [Суть події новини, без зайвої води, але з точно зрозумілою суттю цієї новини і чого вона стосується]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Аналіз від ШІ на що впливає данна новина]
            📈 <b>Опціонний кут:</b> [IV та стратегія, простими словами для новачка в опціонах]
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів і як на них вплине]

            Дані:
            ${newsContent}`;

            let success = false;
            let attempts = 0;

            while (!success && attempts < 3) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 40000))
                    ]);

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
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

                        if (tgRes.ok) {
                            console.log("📨 Надіслано.");
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
                        console.log(`⚠️ Помилка AI (Спроба ${attempts}/3). Чекаємо 15 сек...`);
                        await new Promise(r => setTimeout(r, 15000));
                    } else {
                        console.error(`❌ Помилка: ${err.message}`);
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
