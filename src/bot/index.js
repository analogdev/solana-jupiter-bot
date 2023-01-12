console.clear();

require("dotenv").config();

const JSBI = require('jsbi')
const { clearInterval } = require("timers");
const { PublicKey } = require("@solana/web3.js");

const {
	calculateProfit,
	toDecimal,
	toNumber,
	updateIterationsPerMin,
	checkRoutesResponse,
} = require("../utils");
const { handleExit, logExit } = require("./exit");
const cache = require("./cache");
const { setup, getInitialOutAmount } = require("./setup");
const { printToConsole } = require("./ui/");
const { swap, failedSwapHandler, successSwapHandler } = require("./swap");
const { config } = require("process");

const pingpongStrategy = async (jupiter, prism, tokenA, tokenB) => {
	cache.iteration++;
	const date = new Date();
	const i = cache.iteration;
	cache.queue[i] = -1;

	try {
		// calculate & update iterations per minute
		updateIterationsPerMin(cache);

		// Calculate amount that will be used for trade
		const amountToTrade =
			cache.config.tradeSize.strategy === "cumulative"
				? cache.currentBalance[cache.sideBuy ? "tokenA" : "tokenB"]
				: cache.initialBalance[cache.sideBuy ? "tokenA" : "tokenB"];

		const baseAmount = cache.lastBalance[cache.sideBuy ? "tokenB" : "tokenA"];

		// default slippage
		const slippage =
			typeof cache.config.slippage === "number" ? cache.config.slippage : 1;

		// set input / output token
		const inputToken = cache.sideBuy ? tokenA : tokenB;
		const outputToken = cache.sideBuy ? tokenB : tokenA;

		// check current routes
		const performanceOfRouteCompStart = performance.now();
		let routes
		let route  
		let routes2 
		let route2 
		if (cache.config.aggregator == 'jupiter'){ 
			routes = await jupiter.computeRoutes({
				inputMint: new PublicKey(inputToken.address),
				outputMint: new PublicKey(outputToken.address),
				amount: amountToTrade,
				slippageBps: slippage,
				forceFetch: true,
			});
			checkRoutesResponse(routes);

			// choose first route
			route = await routes.routesInfos[0];
			routes2 = await jupiter.computeRoutes({
				inputMint: new PublicKey(outputToken.address),
				outputMint: new PublicKey(inputToken.address),
				amount: route.outAmount,
				slippageBps: slippage,
				forceFetch: true,
			});
			checkRoutesResponse(routes2);

			// choose first route
			route2 = await routes2.routesInfos[0];
				// count available routes
			cache.availableRoutes[cache.sideBuy ? "buy" : "sell"] =
			routes.routesInfos.length + routes2.routesInfos.length;
			// update slippage with "profit or kill" slippage
			// todo I don't actually know what this does
			if (cache.config.slippage === "profitOrKill") {
				route.amountOut = amountToTrade;
			}
			// todo dunno what this is
			// update slippage with "profit or kill" slippage
			if (cache.config.slippage === "profitOrKill") {
				route.amountOut =
					cache.lastBalance[cache.sideBuy ? "tokenB" : "tokenA"];
			}

		}
		else if (cache.config.aggregator == 'prism'){
			await prism.loadRoutes(inputToken.address, outputToken.address);         // load routes for tokens, tokenSymbol | tokenMint (base58 string)
			routes = prism.getRoutes(amountToTrade / 10 ** inputToken.decimals);                // get routes based on from Token amount 10 USDC -> ? PRISM
			try {
				cache.availableRoutes[cache.sideBuy ? "buy" : "sell"] =
					routes.length;
				route = routes[0];
			}
			catch (err){
				//todo fix this; I don't do uis
				console.log(err);
				return;
			}
		}

		// update status as OK
		cache.queue[i] = 0;

		const performanceOfRouteComp =
			performance.now() - performanceOfRouteCompStart;

		// calculate profitability

		const simulatedProfit = calculateProfit(cache.config.aggregator == 'prism' ? baseAmount : amountToTrade, await Number(cache.config.aggregator == 'prism' ? 
				route.amountOut * 10 ** inputToken.decimals : route2.outAmount.toString()));

		// store max profit spotted
		if (
			simulatedProfit > cache.maxProfitSpotted[cache.sideBuy ? "buy" : "sell"]
		) {
			cache.maxProfitSpotted[cache.sideBuy ? "buy" : "sell"] = simulatedProfit;
		}

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB,
			route,
			simulatedProfit,
		});

		// check profitability and execute tx
		let tx, performanceOfTx;
		if (
			!cache.swappingRightNow &&
			(cache.hotkeys.e ||
				cache.hotkeys.r ||
				simulatedProfit >= cache.config.minPercProfit)
		) {
			// hotkeys
			if (cache.hotkeys.e) {
				console.log("[E] PRESSED - EXECUTION FORCED BY USER!");
				cache.hotkeys.e = false;
			}
			if (cache.hotkeys.r) {
				console.log("[R] PRESSED - REVERT BACK SWAP!");
				route.amountOut = 0;
			}

			if (cache.tradingEnabled || cache.hotkeys.r) {
				cache.swappingRightNow = true;
				// store trade to the history
				let tradeEntry = {
					date: date.toLocaleString(),
					buy: cache.sideBuy,
					inputToken: inputToken.symbol,
					outputToken: outputToken.symbol,
					inAmount: toDecimal(Number(cache.config.aggregator == 'prism' ? 
				route.amountIn / 10 ** inputToken.decimals : route.inAmount.toString()), inputToken.decimals),
					expectedOutAmount: toDecimal(Number(cache.config.aggregator == 'prism' ? 
				route.amountOut / 10 ** inputToken.decimals : route2.outAmount.toString()), inputToken.decimals),
					expectedProfit: simulatedProfit,
				};

				// start refreshing status
				const printTxStatus = setInterval(() => {
					if (cache.swappingRightNow) {
						printToConsole({
							date,
							i,
							performanceOfRouteComp,
							inputToken,
							outputToken,
							tokenA,
							tokenB,
							route,
							simulatedProfit,
						});
					}
				}, 500);
				try {
					[tx, performanceOfTx] = await swap(jupiter, prism, route, route2, inputToken, outputToken);
				}
				catch (err){
					console.log(err)
				}
				// stop refreshing status
				clearInterval(printTxStatus);
				if (false){
					const profit = calculateProfit(
						cache.currentBalance[cache.sideBuy ? "tokenB" : "tokenA"],
						tx.outputAmount
					);

					tradeEntry = {
						...tradeEntry,
						outAmount: tx.outputAmount || 0,
						profit,
						performanceOfTx,
						error: tx.error?.message || null,
					};

					// handle TX results
					if (tx.error) failedSwapHandler(tradeEntry);
					else {
						if (cache.hotkeys.r) {
							console.log("[R] - REVERT BACK SWAP - SUCCESS!");
							cache.tradingEnabled = false;
							console.log("TRADING DISABLED!");
							cache.hotkeys.r = false;
						}
						successSwapHandler(tx, tradeEntry, tokenA, tokenB);
					}
				}
			}
		}

		if (true){//tx) {
			if (true){//!tx.error) {
				// change side
				//cache.sideBuy = !cache.sideBuy;
			}
			cache.swappingRightNow = false;
		}
		
		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB,
			route,
			simulatedProfit,
		});
	} catch (error) {
		cache.queue[i] = 1;
		console.log(error);
	} finally {
		delete cache.queue[i];
	}
};

const arbitrageStrategy = async (jupiter, prism, tokenA) => {
	cache.iteration++;
	const date = new Date();
	const i = cache.iteration;
	cache.queue[i] = -1;
	try {
		// calculate & update iterations per minute
		updateIterationsPerMin(cache);

		// Calculate amount that will be used for trade
		const amountToTrade =
			cache.config.tradeSize.strategy === "cumulative"
				? cache.currentBalance["tokenA"]
				: cache.initialBalance["tokenA"];
		const baseAmount = amountToTrade;

		// default slippage
		const slippage =
			typeof cache.config.slippage === "number" ? cache.config.slippage : 1;
		// set input / output token
		const inputToken = tokenA;
		const outputToken = tokenA;

		// check current routes
		const performanceOfRouteCompStart = performance.now();
		let routes
		let route  
		if (cache.config.aggregator == 'jupiter'){ 
			routes = await jupiter.computeRoutes({
				inputMint: new PublicKey(inputToken.address),
				outputMint: new PublicKey(outputToken.address),
				amount: amountToTrade,
				slippageBps: slippage,
				forceFetch: true,
			});
			checkRoutesResponse(routes);

			// choose first route
			route = await routes.routesInfos[1];
				// count available routes
			cache.availableRoutes[cache.sideBuy ? "buy" : "sell"] =

			routes.routesInfos.length;
			// update slippage with "profit or kill" slippage
			// todo I don't actually know what this does
			if (cache.config.slippage === "profitOrKill") {
				route.amountOut = amountToTrade;
			}

		}
		else if (cache.config.aggregator == 'prism'){
			await prism.loadRoutes(inputToken.address, outputToken.address);         // load routes for tokens, tokenSymbol | tokenMint (base58 string)
			routes = prism.getRoutes(amountToTrade / 10 ** inputToken.decimals);                // get routes based on from Token amount 10 USDC -> ? PRISM
			try {
				cache.availableRoutes[cache.sideBuy ? "buy" : "sell"] =
					routes.length;
				route = routes[1];
			}
			catch (err){
				//todo fix this; I don't do uis
				console.log(err);
				return;
			}
		}

		// update status as OK
		cache.queue[i] = 0;

		const performanceOfRouteComp =
			performance.now() - performanceOfRouteCompStart;

		// calculate profitability

		const simulatedProfit = calculateProfit(baseAmount, await Number(cache.config.aggregator == 'prism' ? 
				route.amountOut * 10 ** inputToken.decimals : route.outAmount.toString()));

		// store max profit spotted
		if (simulatedProfit > cache.maxProfitSpotted["buy"]) {
			cache.maxProfitSpotted["buy"] = simulatedProfit;
		}

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB: tokenA,
			route,
			simulatedProfit,
		});

		// check profitability and execute tx
		let tx, performanceOfTx;
		if (
			!cache.swappingRightNow &&
			(cache.hotkeys.e ||
				cache.hotkeys.r ||
				simulatedProfit >= cache.config.minPercProfit)
		) {
			// hotkeys
			if (cache.hotkeys.e) {
				console.log("[E] PRESSED - EXECUTION FORCED BY USER!");
				cache.hotkeys.e = false;
			}
			if (cache.hotkeys.r) {
				console.log("[R] PRESSED - REVERT BACK SWAP!");
				route.amountOut = 0;
			}

			if (cache.tradingEnabled || cache.hotkeys.r) {
				try {
					cache.swappingRightNow = true;
					// store trade to the history
					let tradeEntry = {
						date: date.toLocaleString(),
						buy: cache.sideBuy,
						inputToken: inputToken.symbol,
						outputToken: outputToken.symbol,
						inAmount: toDecimal(Number(cache.config.aggregator == 'prism' ? 
				route.amountIn / 10 ** inputToken.decimals : route.inAmount.toString()), inputToken.decimals),
						expectedOutAmount: toDecimal(Number(cache.config.aggregator == 'prism' ? 
				route.amountOut / 10 ** inputToken.decimals : route.outAmount.toString()), outputToken.decimals),
						expectedProfit: simulatedProfit,
					};

					// start refreshing status
					const printTxStatus = setInterval(() => {
						if (cache.swappingRightNow) {
							printToConsole({
								date,
								i,
								performanceOfRouteComp,
								inputToken,
								outputToken,
								tokenA,
								tokenB: tokenA,
								route,
								simulatedProfit,
							});
						}
					}, 500);

					[tx, performanceOfTx] = await swap(jupiter, prism, route);
try {// so anyways the lesson here is to use less esoteric anyspl tokens - yawn. I'm so incredibly tired
					// stop refreshing status zzz zzz zz zzzz z zz 
					clearInterval(printTxStatus);
					//this is the ui stuff that's broken regardless - like the way the tx's used to be parsed. that said, we can probably parse the successful ones with solscanparser
					const profit = calculateProfit(tradeEntry.inAmount, tx.outputAmount);

					tradeEntry = {
						...tradeEntry,
						outAmount: tx.outputAmount || 0,
						profit,
						performanceOfTx,
						error: tx.error?.message || null,
					};

					// handle TX results
					if (tx.error) failedSwapHandler(tradeEntry);
					else {
						if (cache.hotkeys.r) {
							console.log("[R] - REVERT BACK SWAP - SUCCESS!");
							cache.tradingEnabled = false;
							console.log("TRADING DISABLED!");
							cache.hotkeys.r = false;
						}
						successSwapHandler(tx, tradeEntry, tokenA, tokenA);
					}
				} catch (err){

				}
				}
				catch (err){
					console.log(err)
				}
			}
		}

		if (tx) {
			cache.swappingRightNow = false;
		}

		printToConsole({
			date,
			i,
			performanceOfRouteComp,
			inputToken,
			outputToken,
			tokenA,
			tokenB: tokenA,
			route,
			simulatedProfit,
		});
	} catch (error) {
		cache.queue[i] = 1;
		throw error;
	} finally {
		delete cache.queue[i];
	}
};

const watcher = async (jupiter, prism, tokenA, tokenB) => {
	if (
		!cache.swappingRightNow &&
		Object.keys(cache.queue).length < cache.queueThrottle
	) {
		if (cache.config.tradingStrategy === "pingpong") {
			await pingpongStrategy(jupiter, prism, tokenA, tokenB);
		}
		if (cache.config.tradingStrategy === "arbitrage") {
			await arbitrageStrategy(jupiter, prism, tokenA);
		}
	}
};

const run = async () => {
	try {
		// set everything up
		const { jupiter, prism, tokenA, tokenB } = await setup();

		if (cache.config.tradingStrategy === "pingpong") {
			// set initial & current & last balance for tokenA
			cache.initialBalance.tokenA = toNumber(
				cache.config.tradeSize.value,
				tokenA.decimals
			);
			cache.currentBalance.tokenA = cache.initialBalance.tokenA;
			cache.lastBalance.tokenA = cache.initialBalance.tokenA;

			// set initial & last balance for tokenB
			cache.initialBalance.tokenB = Number((await getInitialOutAmount(

				jupiter,
				tokenA,
				tokenB,
				cache.initialBalance.tokenA
			)).toString());

			cache.lastBalance.tokenB = cache.initialBalance.tokenB;
		} else if (cache.config.tradingStrategy === "arbitrage") {
			// set initial & current & last balance for tokenA
			cache.initialBalance.tokenA = toNumber(
				cache.config.tradeSize.value,
				tokenA.decimals
			);
			cache.currentBalance.tokenA = cache.initialBalance.tokenA;
			cache.lastBalance.tokenA = cache.initialBalance.tokenA;
		}

		global.botInterval = setInterval(
			() => watcher(jupiter, prism, tokenA, tokenB),
			cache.config.minInterval
		);
	} catch (error) {
		logExit(error);
		process.exitCode = 1;
	}
};

run();

// handle exit
process.on("exit", handleExit);