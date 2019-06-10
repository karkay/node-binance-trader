const express = require('express')
const socketIO = require('socket.io')
const io_client = require('socket.io-client')
const path = require('path')
const StochRSI = require('technicalindicators').stochasticrsi
const binance = require('binance-api-node').default
const moment = require('moment')
const BigNumber = require('bignumber.js')
const colors = require("colors")
const soundplayer = require('sound-player')
const _ = require('lodash')
const fs = require('fs')
const ora = require('ora')

const PORT = process.env.PORT || 4000
const INDEX = path.join(__dirname, 'index.html')

//////////////////////////////////////////////////////////////////////////////////

const sound_alert = true               // if true a sound alert will be played for each signals
const insert_into_files = true         // to save pair data to txt files in the data sub-folder 
const send_signal_to_bva = true        // to send your signals to NBT Hub a.k.a http://bitcoinvsaltcoins.com

const tracked_max = 200                 // max of pairs to be tracked (useful for testing)
const wait_time = 800                   // to time out binance api calls (a lower number than 800 can result in api rstriction)

const stop_loss_pnl = -0.81         // to set your stop loss per trade
const stop_profit_pnl = 1.81        // to set your stop profit per trade

/////////////////////////////////////////////////////////////////////////////////

console.log("sound_alert: ", sound_alert)
console.log("insert_into_files: ", insert_into_files)
console.log("send_signal_to_bva: ", send_signal_to_bva)

let socket_client = {}
if (send_signal_to_bva) { 
    // create a socket client connection to send your signals to NBT Hub (http://bitcoinvsaltcoins.com)
    socket_client = io_client('https://nbt-hub.herokuapp.com') 
}

let alert_sound = {}
if (sound_alert) {
    // quick sound alert test at the beginning
    alert_sound = new soundplayer({ filename: "alert.mp3", gain: 1})
}

/////////////////////

let pairs = []
const nbt_prefix = "oasis_"
const interv_time = 10000
let sum_bids = {}
let sum_asks = {}
let first_bid_qty = {}
let first_ask_qty = {}
let first_bid_price = {}
let first_ask_price = {}
let prices = {}
let volumes = {}
let trades = {}
let makers = {}
let interv_vols_sum = {}
let candle_prices = {}
let candle_lowes = {}
let candle_highs = {}
let srsi = {}
let signaled_pairs = {}
let buy_prices = {}

//////////////////////////////////////////////////////////////////////////////////

const server = express()
    .use((req, res) => res.sendFile(INDEX) )
    .listen(PORT, () => console.log(`NBT server running on port ${ PORT }`))

const io = socketIO(server)

io.on('connection', (socket) => {
    console.log(' ...client connected'.grey);
    socket.on('disconnect', () => console.log(' ...client disconnected'.grey))
    socket.on('message', (message) => console.log(' ...client message :: ' + message))
})

if (send_signal_to_bva) {
    socket_client.on('connect', () => {})
}

//////////////////////////////////////////////////////////////////////////////////
// BINANCE API initialization //

const binance_client = binance()

//////////////////////////////////////////////////////////////////////////////////

const report = ora('Starting NBT server...'.grey)
report.start()
report.text = ""

async function run() {
    if (sound_alert) { alert_sound.play() }
    pairs = await get_pairs()
    pairs = pairs.slice(0, tracked_max)
    pairs.unshift('BTCUSDT')
    console.log(" ")
    console.log("Total pairs: " + pairs.length)
    console.log(" ")
    console.log(JSON.stringify(pairs))
    console.log(" ")
    await sleep(wait_time)
    await trackData()
}

async function get_pairs() {
    const exchange_info = await binance_client.exchangeInfo()
    const pre_USDT_select = exchange_info.symbols.filter( pair => pair.symbol.endsWith('USDT') && pair.status == 'TRADING').map(pair=>{
        return pair.symbol.substring(0, pair.symbol.length-4)
    })
    const pre_BTC_select = exchange_info.symbols.filter( pair => pair.symbol.endsWith('BTC') && pair.status == 'TRADING').map(pair=>{
        return pair.symbol.substring(0, pair.symbol.length-3)
    })
    const assets = _.intersection(pre_USDT_select, pre_BTC_select)
    return assets.map(asset => asset+'BTC')
}

async function trackData() {
	for (var i = 0, len = pairs.length; i < len; i++) {
        await trackPairData(pairs[i])
		await sleep(wait_time)
	}
}

async function trackPairData(pair) {

    sum_bids[pair] = []
    sum_asks[pair] = []
    first_bid_qty[pair] = new BigNumber(0)
    first_ask_qty[pair] = new BigNumber(0)
    first_bid_price[pair] = new BigNumber(0)
    first_ask_price[pair] = new BigNumber(0)
    prices[pair] = new BigNumber(0)
    volumes[pair] = []
    makers[pair] = []
    trades[pair] = []
    candle_prices[pair] = []
    candle_highs[pair] = []
    candle_lowes[pair] = []
    prev_price = new BigNumber(0)
    prev_bid = new BigNumber(0)
    prev_ask = new BigNumber(0)
    interv_vols_sum[pair] = new BigNumber(0)
    srsi[pair] = new BigNumber(0)

    const candles_15 = await binance_client.candles({ symbol: pair, interval: '15m' })
    for (var i = 0, len = candles_15.length; i < len; i++) {
        candle_prices[pair].push(Number(candles_15[i].close))
        candle_lowes[pair].push(Number(candles_15[i].low))
        candle_highs[pair].push(Number(candles_15[i].high))
    }

    await sleep(wait_time)

    const candles_clean = binance_client.ws.candles(pair, '15m', async candle => {
        if (candle.isFinal) {
            candle_prices[pair].push(Number(candle.close))
            candle_lowes[pair].push(Number(candle.low))
            candle_highs[pair].push(Number(candle.high))
        }
        else {
            candle_prices[pair][candle_prices[pair].length-1] = Number(candle.close)
            candle_lowes[pair][candle_lowes[pair].length-1] = Number(candle.low)
            candle_highs[pair][candle_highs[pair].length-1] = Number(candle.high)
        }
        const srsi_res = StochRSI({
            values: candle_prices[pair],
            rsiPeriod: 100,
            stochasticPeriod: 100,
            kPeriod: 1,
            dPeriod: 1,
        })
        srsi[pair] = BigNumber(srsi_res[srsi_res.length-1].k)

        const max_sum_asks_bn = new BigNumber(_.max(sum_asks[pair]))
        const min_sum_asks_bn = new BigNumber(_.min(sum_asks[pair]))

        //////////////////////////////////////////////////////////////////////////////////////////

        const author_name = "your_signal_author_name"       // enter your name
        const author_key = "your_unique_author_key"         // please use an unique key for this from https://randomkeygen.com
        let curr_price = new BigNumber(0)
        let pnl = new BigNumber(0)
        let signal_name, signal_key, description

        //////////////////////////////// SIGNAL DECLARATION - START /////////////////////////////////

        signal_name = "SIGNAL TEST"                                   // enter the name of your signal
        signal_key = signal_name.replace(/\s+/g, '') + author_key
        description = signal_name + " :: " + interv_vols_sum[pair].times(first_ask_price[pair]).toFormat(2) + " " + srsi[pair].toFormat(2)
        
        //////// BUY SIGNAL DECLARATION ///////
        if ( interv_vols_sum[pair].times(first_ask_price[pair]).isGreaterThan(10.0) 
            && srsi[pair].isGreaterThan(69) 
            && !signaled_pairs[pair+signal_key]
        ) {
            signaled_pairs[pair+signal_key] = true
            buy_prices[pair+signal_key] = new BigNumber(first_ask_price[pair])
            report.stop()
            console.log(pair.green + " BUY =>   " + signal_name.green 
                + " " + interv_vols_sum[pair].times(first_ask_price[pair]).toFormat(2))
                + " " + trades[pair][trades[pair].length-1]
                + " " + _.mean(trades[pair].slice(-6, trades[pair].length-1)
            )
            report.start()
            const buy_signal = {
                author_name: author_name, 
                author_key: author_key,
                signal_name: signal_name, 
                signal_key: signal_key, 
                description: description,
                pair: pair, 
                buy_price: first_ask_price[pair]
            }
            io.emit('buy_signal', buy_signal)
            if (send_signal_to_bva) { socket_client.emit("buy_signal", buy_signal) }
            if (sound_alert) { alert_sound.play() }
        }
        //////// SELL SIGNAL DECLARATION ///////
        curr_price = BigNumber(first_bid_price[pair])
        pnl = curr_price.minus(buy_prices[pair+signal_key]).times(100).dividedBy(buy_prices[pair+signal_key])
        if ( candle_prices[pair][candle_prices[pair].length-1] < candle_prices[pair][candle_prices[pair].length-2]
            && (pnl.isLessThan(stop_loss_pnl) || pnl.isGreaterThan(stop_profit_pnl))
            && signaled_pairs[pair+signal_key]
        ) {
            signaled_pairs[pair+signal_key] = false
            report.stop()
            console.log(pair.red + " SELL =>   " + signal_name.red)
            report.start()
            const sell_signal = {
                author_key: author_key,
                signal_name: signal_name, 
                signal_key: signal_key, 
                pair: pair, 
                sell_price: first_bid_price[pair]
            }
            io.emit('sell_signal', sell_signal)
            if (send_signal_to_bva) { socket_client.emit("sell_signal", sell_signal) }
            if (sound_alert) { alert_sound.play() }
        }

        //////////////////////////////// SIGNAL DECLARATION - END /////////////////////////////////
    })

    await sleep(wait_time)

    //console.log(colors.grey('scanning '+pair+' depth...'))
    const depth_clean = binance_client.ws.partialDepth({ symbol: pair, level: 10 }, depth => {
        sum_bids[pair].push(_.sumBy(depth.bids, (o) => { return Number(o.quantity) }))
        sum_asks[pair].push(_.sumBy(depth.asks, (o) => { return Number(o.quantity) }))
        first_bid_qty[pair] = BigNumber(depth.bids[0].quantity)
        first_ask_qty[pair] = BigNumber(depth.asks[0].quantity)
        first_bid_price[pair] = BigNumber(depth.bids[0].price)
        first_ask_price[pair] = BigNumber(depth.asks[0].price)
    })

    await sleep(wait_time)

    //console.log(colors.grey('scanning '+pair+' trades...'))
    const trades_clean = binance_client.ws.trades([pair], trade => {
        prices[pair] = BigNumber(trade.price)
        volumes[pair].unshift({
            'timestamp': Date.now(), 
            'volume': parseFloat(trade.quantity),
        })
        makers[pair].unshift({
            'timestamp': Date.now(), 
            'maker': trade.maker, 
        })
    })

    setInterval( () => {

        let depth_report = ""
        let depth_report_colored = ""

        const last_sum_bids_bn = new BigNumber(sum_bids[pair][sum_bids[pair].length-1])
        const last_sum_asks_bn = new BigNumber(sum_asks[pair][sum_asks[pair].length-1])

        if (last_sum_bids_bn.isLessThan(last_sum_asks_bn)) {
            depth_report_colored = last_sum_asks_bn.dividedBy(last_sum_bids_bn).decimalPlaces(2).toString().magenta
            depth_report = "-" + last_sum_asks_bn.dividedBy(last_sum_bids_bn).decimalPlaces(2).toString()
        }
        else {
            depth_report_colored = last_sum_bids_bn.dividedBy(last_sum_asks_bn).decimalPlaces(2).toString().blue
            depth_report = "+" + last_sum_bids_bn.dividedBy(last_sum_asks_bn).decimalPlaces(2).toString()
        }
        
        interv_vols_sum[pair] = BigNumber(_.sumBy(volumes[pair], 'volume'))
        trades[pair].push(volumes[pair].length)
        
        const makers_count = new BigNumber(_.filter(makers[pair], (o) => { if (o.maker) return o }).length)
        const makers_total = new BigNumber(makers[pair].length)
        const maker_ratio = makers_count > 0 ? makers_count.dividedBy(makers_total).times(100) : new BigNumber(0)

        report.text = moment().format().grey.padStart(20) +
            pair.white.padStart(20) +
            (prev_price.isEqualTo(prices[pair]) ? colors.grey(prices[pair]).padStart(30) : prev_price.isLessThan(prices[pair]) ? colors.green(prices[pair]).padStart(30) : colors.red(prices[pair]).padStart(30)) + 
            colors.white(interv_vols_sum[pair].decimalPlaces(3).toString()).padStart(30) +
            colors.blue(trades[pair][trades[pair].length-1]).padStart(20) +
            colors.yellow(maker_ratio.decimalPlaces(2).toString() + "%").padStart(20) +
            depth_report_colored.padStart(20) +
            colors.grey(last_sum_bids_bn.toFormat(2)).padStart(30) +
            colors.grey(last_sum_asks_bn.toFormat(2)).padStart(30) +
            colors.cyan(srsi[pair].decimalPlaces(2).toFormat(2)).padStart(20)

        if (BigNumber.isBigNumber(srsi[pair]) && prices[pair].isGreaterThan(0) && last_sum_bids_bn.isGreaterThan(0) && last_sum_asks_bn.isGreaterThan(0)) {
                
            const insert_values = [
                Date.now(), 
                Number(prices[pair]), 
                Number(interv_vols_sum[pair].decimalPlaces(3).toString()), 
                Number(volumes[pair].length), //trades
                Number(maker_ratio.decimalPlaces(2).toString()),
                Number(depth_report),
                Number(last_sum_bids_bn), 
                Number(last_sum_asks_bn), 
                Number(first_bid_price[pair]), 
                Number(first_ask_price[pair]), 
                Number(first_bid_qty[pair]), 
                Number(first_ask_qty[pair]),
                Number(srsi[pair].decimalPlaces(2).toString()),
            ]

            io.emit(pair, insert_values)

            // FILE INSERT
            if (insert_into_files) {
                const log_report = moment().format().padStart(30) +
                        pair.padStart(20) +
                        String(prices[pair]).padStart(30) +
                        interv_vols_sum[pair].decimalPlaces(3).toString().padStart(30) +
                        String(volumes[pair].length).padStart(20) +
                        maker_ratio.decimalPlaces(2).toString().padStart(20) +
                        depth_report.padStart(30) +
                        last_sum_bids_bn.decimalPlaces(3).toString().padStart(30) +
                        last_sum_asks_bn.decimalPlaces(3).toString().padStart(30) +
                        first_bid_price[pair].toString().padStart(30) +
                        first_bid_qty[pair].decimalPlaces(6).toString().padStart(30) +
                        first_ask_qty[pair].decimalPlaces(6).toString().padStart(30) +
                        first_ask_price[pair].toString().padStart(30) +
                        srsi[pair].decimalPlaces(3).toString().padStart(30)
                fs.appendFileSync( "data/" + nbt_prefix + pair + ".txt", log_report + "\n" )
            }
        }

        // clean up arrays...
        makers[pair] = _.filter(makers[pair], (v) => { return (v.timestamp >= (Date.now()-interv_time)) })
        volumes[pair] = _.filter(volumes[pair], (v) => { return (v.timestamp >= (Date.now()-interv_time)) })
        sum_asks[pair] = sum_asks[pair].slice(sum_asks[pair].length - 33, 33)
        sum_bids[pair] = sum_bids[pair].slice(sum_bids[pair].length - 33, 33)

        prev_price = BigNumber(prices[pair])

    }, 1000)
}

sleep = (x) => {
	return new Promise(resolve => {
		setTimeout(() => { resolve(true) }, x )
	})
}

run()