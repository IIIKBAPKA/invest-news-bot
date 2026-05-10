async function runSniper() {
    console.log("🎯 Завантаження даних та аналіз збігів...");
    
    try {
        const insiders = await getInsiderBuys();
        const politicians = await getPoliticalBuys();
        
        // --- БЛОК ДЕБАГУ ---
        const insiderTickers = Object.keys(insiders);
        const polTickers = Object.keys(politicians);
        
        console.log(`\n📊 ДЕБАГ СТАТИСТИКА:`);
        console.log(`👔 Знайдено великих інсайдерських купівель (унікальних компаній): ${insiderTickers.length}`);
        if (insiderTickers.length > 0) console.log(`👉 Приклади: ${insiderTickers.slice(0, 5).join(', ')}...`);
        
        console.log(`🏛 Знайдено політичних купівель (унікальних компаній): ${polTickers.length}`);
        if (polTickers.length > 0) console.log(`👉 Приклади: ${polTickers.slice(0, 5).join(', ')}...`);
        console.log(`-------------------------\n`);
        // -------------------

        let foundMatches = false;
        let message = "🎯 <b>СНАЙПЕР: ЗЛИТТЯ ГРОШЕЙ</b> 🎯\n\n";
        
        for (const ticker in politicians) {
            if (insiders[ticker]) {
                foundMatches = true;
                message += `🔥 <b>${ticker}</b>\n`;
                
                message += `🏛 <b>Політики:</b>\n`;
                politicians[ticker].forEach(p => {
                    message += `└ ${p.name} | Сума: ${p.amount} | Дата: ${p.date}\n`;
                });
                
                message += `👔 <b>Інсайдери (ТОП-менеджмент):</b>\n`;
                insiders[ticker].slice(0, 3).forEach(i => { 
                    let shortTitle = i.title.length > 20 ? i.title.substring(0,20)+"..." : i.title;
                    message += `└ ${i.name} (${shortTitle}) | <b>${formatMoney(i.amount)}</b> | Дата: ${i.date}\n`;
                });
                
                message += `\n`;
            }
        }
        
        if (!foundMatches) {
            message += "🤷‍♂️ Сьогодні спільних покупок (Інсайдери + Політики) не знайдено.";
            console.log("Результат: Збігів немає.");
        } else {
            message += "💡 <i>Перевірте ці тікери у вашому сканері опціонів!</i>";
            console.log("Результат: ЗНАЙДЕНО ЗБІГИ!");
        }
        
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
        
        console.log("📨 Звіт снайпера відправлено в Telegram!");

    } catch (error) {
        console.error("❌ Помилка:", error);
    }
}
