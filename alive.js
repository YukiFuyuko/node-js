const mineflayer = require('mineflayer');

const botArgs = {
    host: 'Hot-Snow.play.hosting',
    port: 25565, // Default MC port
    username: 'Misaki',
    version: '1.21.11' // Mineflayer uses 1.21.1 for 1.21.11 compatibility
};

let bot;

function createBot() {
    bot = mineflayer.createBot(botArgs);

    bot.on('spawn', () => {
        console.log('Misaki has spawned in the server.');
        startMovementLoop();
    });

    // Auto Reconnect Logic
    bot.on('end', (reason) => {
        console.log(`Disconnected: ${reason}. Reconnecting in 5 seconds...`);
        setTimeout(createBot, 5000);
    });

    bot.on('error', (err) => {
        console.log('Encountered an error:', err);
    });
}

// 1. Movement Loop: Forward -> Left -> Backward -> Right
async function startMovementLoop() {
    const directions = ['forward', 'left', 'back', 'right'];
    let i = 0;

    while (true) {
        if (!bot || !bot.entity) {
            await new Promise(res => setTimeout(res, 1000));
            continue;
        }

        const dir = directions[i % directions.length];
        bot.setControlState(dir, true);
        await new Promise(res => setTimeout(res, 1000)); // Move for 1 second
        bot.setControlState(dir, false);

        i++;
        await new Promise(res => setTimeout(res, 500)); // Short pause between moves
    }
}

createBot();
