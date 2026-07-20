(function() {
    const PIECE_THEME = 'pieces/{piece}.png';

    const params = new URLSearchParams(window.location.search);
    const hostId = params.get('host');
    const isHost = params.get('as') === 'host';

    if (!hostId) {
        showError('لم يتم العثور على رابط اللعبة. اطلب من خصمك رابطاً جديداً، أو ابدأ لعبة جديدة.');
        return;
    }

    const STORAGE_KEY = 'chess_game_state_' + hostId;

    const game = new Chess();
    let board = null;
    let conn = null;
    let peer = null;

    let myColor = isHost ? 'w' : 'b';
    let opponentColor = isHost ? 'b' : 'w';

    let pendingPromotion = null;
    let promoColor = 'w';

    let activeTurn = 'w';
    let turnMoveCount = 0;
    let gameEnded = false;

    const timeParamMinutes = parseFloat(params.get('time'));
    const incParamSeconds = parseFloat(params.get('inc'));

    const BASE_TIME = (!isNaN(timeParamMinutes) && timeParamMinutes > 0) ? timeParamMinutes * 60 : 180;
    const INCREMENT = (!isNaN(incParamSeconds) && incParamSeconds >= 0) ? incParamSeconds : 2;
    const GRACE_TIME = 10;

    let clocks = { w: BASE_TIME, b: BASE_TIME };
    let firstMoveDone = { w: false, b: false };
    let currentGraceLeft = GRACE_TIME;

    let clockInterval = null;
    let lastTick = null;

    function saveGameToStorage() {
        if (gameEnded) {
            localStorage.removeItem(STORAGE_KEY);
            return;
        }
        const state = {
            fen: game.fen(),
            activeTurn: activeTurn,
            turnMoveCount: turnMoveCount,
            clocks: clocks,
            firstMoveDone: firstMoveDone,
            currentGraceLeft: currentGraceLeft,
            myColor: myColor,
            opponentColor: opponentColor
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function loadGameFromStorage() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return false;
        try {
            const state = JSON.parse(saved);
            game.load(state.fen);
            activeTurn = state.activeTurn;
            turnMoveCount = state.turnMoveCount;
            clocks = state.clocks;
            firstMoveDone = state.firstMoveDone;
            currentGraceLeft = state.currentGraceLeft;
            myColor = state.myColor;
            opponentColor = state.opponentColor;
            return true;
        } catch (e) {
            console.error("خطأ في استعادة اللعبة المخرونة", e);
            return false;
        }
    }

    function formatTime(seconds, isGraceActive, graceSeconds) {
        if (isGraceActive && graceSeconds > 0) {
            return '⏳ ' + Math.ceil(graceSeconds) + 's';
        }
        const s = Math.max(0, Math.ceil(seconds));
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return m + ':' + String(rem).padStart(2, '0');
    }

    function updateClockDisplay() {
        const isWhiteGrace = !firstMoveDone.w && activeTurn === 'w';
        const isBlackGrace = !firstMoveDone.b && activeTurn === 'b';

        const isMyGraceActive = (myColor === 'w' ? isWhiteGrace : isBlackGrace);
        const isOpponentGraceActive = (opponentColor === 'w' ? isWhiteGrace : isBlackGrace);

        document.getElementById('myTime').textContent = formatTime(clocks[myColor], isMyGraceActive, currentGraceLeft);
        document.getElementById('opponentTime').textContent = formatTime(clocks[opponentColor], isOpponentGraceActive, currentGraceLeft);
        
        document.getElementById('opponentClockLabel').textContent = (opponentColor === 'w') ? 'الخصم (الأبيض)' : 'الخصم (الأسود)';

        document.getElementById('myClock').classList.toggle('active', activeTurn === myColor && !gameEnded);
        document.getElementById('opponentClock').classList.toggle('active', activeTurn === opponentColor && !gameEnded);
        
        document.getElementById('myClock').classList.toggle('low', clocks[myColor] <= 30 && !isMyGraceActive);
        document.getElementById('opponentClock').classList.toggle('low', clocks[opponentColor] <= 30 && !isOpponentGraceActive);
    }

    function startClock() {
        stopClock();
        lastTick = Date.now();
        clockInterval = setInterval(tickClock, 200);
    }

    function stopClock() {
        if (clockInterval) {
            clearInterval(clockInterval);
            clockInterval = null;
        }
    }

    function resetClocks() {
        clocks = { w: BASE_TIME, b: BASE_TIME };
        firstMoveDone = { w: false, b: false };
        currentGraceLeft = GRACE_TIME;
        updateClockDisplay();
    }

    function tickClock() {
        if (gameEnded) { stopClock(); return; }
        const now = Date.now();
        const delta = (now - lastTick) / 1000;
        lastTick = now;

        if (!firstMoveDone[activeTurn]) {
            currentGraceLeft -= delta;
            if (currentGraceLeft <= 0) {
                firstMoveDone[activeTurn] = true; 
                clocks[activeTurn] += currentGraceLeft; 
                currentGraceLeft = 0;
            }
        } else {
            clocks[activeTurn] -= delta;
        }

        if (clocks[activeTurn] <= 0) {
            clocks[activeTurn] = 0;
            updateClockDisplay();
            triggerTimeout(activeTurn);
            return;
        }
        updateClockDisplay();
        saveGameToStorage();
    }

    function triggerTimeout(color) {
        if (gameEnded) return;
        stopClock();
        localStorage.removeItem(STORAGE_KEY);
        if (conn && conn.open) {
            conn.send({ type: 'timeout', color: color });
        }
        const winnerName = (color === 'w') ? 'الأسود' : 'الأبيض';
        const loserName = (color === 'w') ? 'الأبيض' : 'الأسود';
        showResult('فاز ' + winnerName, 'انتهى وقت لاعب ' + loserName + '.', true);
    }

    function handleOpponentTimeout(color) {
        if (gameEnded) return;
        stopClock();
        localStorage.removeItem(STORAGE_KEY);
        const winnerName = (color === 'w') ? 'الأسود' : 'الأبيض';
        const loserName = (color === 'w') ? 'الأبيض' : 'الأسود';
        showResult('فاز ' + winnerName, 'انتهى وقت لاعب ' + loserName + '.', true);
    }

    function processTurnIncrement() {
        firstMoveDone[activeTurn] = true;
        turnMoveCount++;
        if (turnMoveCount >= 2) {
            turnMoveCount = 0;
            clocks[activeTurn] += INCREMENT;
            activeTurn = (activeTurn === 'w') ? 'b' : 'w';
            currentGraceLeft = firstMoveDone[activeTurn] ? 0 : GRACE_TIME;
        }
        
        const fenParts = game.fen().split(' ');
        fenParts[1] = activeTurn;
        fenParts[3] = '-';
        game.load(fenParts.join(' '));
        updateTurnStrip();
        updateClockDisplay();
        saveGameToStorage(); // حفظ بعد انتهاء النقلة
    }

    function updateTurnStrip() {
        document.getElementById('youAre').textContent = (myColor === 'w') ? 'الأبيض' : 'الأسود';
        document.getElementById('turnLabel').textContent = (activeTurn === 'w') ? 'الأبيض' : 'الأسود';
        document.getElementById('pip1').classList.toggle('done', turnMoveCount >= 1);
        document.getElementById('pip2').classList.toggle('done', turnMoveCount >= 2);
    }

    let selectedSquare = null;

    function removeGreySquares() {
        $('#myBoard .square-55d63').css('background', '');
    }

    function greySquare(square) {
        const $sq = $('#myBoard .square-' + square);
        $sq.css('background', $sq.hasClass('black-3c85d') ? '#5c5346' : '#7a6f5d');
    }

    function highlightSelected(square) {
        greySquare(square);
        const moves = game.moves({ square: square, verbose: true });
        moves.forEach(m => greySquare(m.to));
    }

    function clearSelection() {
        selectedSquare = null;
        removeGreySquares();
    }

    function isOwnPiece(square) {
        const piece = game.get(square);
        if (!piece) return false;
        return piece.color === myColor;
    }

    // ينفذ نقلة من source الى target سواء جايه من سحب او دوسة، ويرجع:
    // 'illegal' لو النقلة مش مسموحة، 'promotion' لو محتاجة ترقية، 'done' لو اتنفذت وبُعتت للخصم
    function performMove(source, target) {
        const move = game.move({ from: source, to: target, promotion: 'q' });
        if (move === null) return 'illegal';

        if (turnMoveCount === 0 && game.in_check()) {
            game.undo();
            return 'illegal';
        }

        if (move.flags.includes('p')) {
            pendingPromotion = { source: source, target: target };
            promoColor = activeTurn;
            game.undo();
            showPromotionBox();
            return 'promotion';
        }

        sendMove({ from: source, to: target, promotion: null });
        processTurnIncrement();
        checkGameEnd();
        return 'done';
    }

    function getSquareFromElement(el) {
        if (!el || !el.classList) return null;
        for (const c of el.classList) {
            if (/^square-[a-h][1-8]$/.test(c)) return c.replace('square-', '');
        }
        return null;
    }

    function onSquareTap(square) {
        if (game.game_over() || gameEnded) return;
        if (!conn || !conn.open) return;
        if (activeTurn !== myColor) return;

        if (!selectedSquare) {
            if (isOwnPiece(square)) {
                selectedSquare = square;
                highlightSelected(square);
            }
            return;
        }

        if (square === selectedSquare) {
            clearSelection();
            return;
        }

        if (isOwnPiece(square)) {
            removeGreySquares();
            selectedSquare = square;
            highlightSelected(square);
            return;
        }

        const source = selectedSquare;
        clearSelection();
        const result = performMove(source, square);
        if (result === 'done') {
            board.position(game.fen());
        }
    }

    const onMouseoverSquare = function(square) {
        if (selectedSquare) return;
        if (activeTurn !== myColor) return;
        const moves = game.moves({ square: square, verbose: true });
        if (!moves.length) return;
        greySquare(square);
        moves.forEach(m => greySquare(m.to));
    };

    function checkGameEnd() {
        if (game.in_checkmate()) {
            localStorage.removeItem(STORAGE_KEY);
            const winner = (activeTurn === 'w') ? 'الأسود' : 'الأبيض';
            showResult('كِش مَلك! فاز ' + winner, 'انتهت المباراة بنصر حاسم.', true);
        } else if (game.in_draw()) {
            localStorage.removeItem(STORAGE_KEY);
            showResult('تعادل', 'تعادل بسبب مخنوق (Stalemate) أو عدم كفاية القطع.', true);
        } else if (game.in_stalemate && game.in_stalemate()) {
            localStorage.removeItem(STORAGE_KEY);
            showResult('تعادل', 'ملك مخنوق (Stalemate).', true);
        }
    }

    function showResult(title, sub, endsGame) {
        if (endsGame) {
            gameEnded = true;
            stopClock();
            localStorage.removeItem(STORAGE_KEY);
        }
        document.getElementById('resultText').textContent = title;
        document.getElementById('resultSub').textContent = sub;
        document.getElementById('resultActions').style.display = 'flex';
        document.getElementById('pendingNote').style.display = 'none';
        document.getElementById('rematchBtn').disabled = false;
        document.getElementById('rematchBtn').textContent = 'جيم كمان ';
        document.getElementById('resultVeil').classList.add('show');
    }

    function resetGameState(swapColors) {
        localStorage.removeItem(STORAGE_KEY);
        game.reset();
        board.position('start');
        activeTurn = 'w';
        turnMoveCount = 0;
        gameEnded = false;
        pendingPromotion = null;
        if (swapColors) {
            myColor = (myColor === 'w') ? 'b' : 'w';
            opponentColor = (opponentColor === 'w') ? 'b' : 'w';
            board.orientation((myColor === 'w') ? 'white' : 'black');
        }
        document.getElementById('promotionBox').style.display = 'none';
        document.getElementById('resultVeil').classList.remove('show');
        document.getElementById('rematchRequestVeil').classList.remove('show');
        removeGreySquares();
        updateTurnStrip();
        resetClocks();
        startClock();
        saveGameToStorage();
    }

    window.requestRematch = function() {
        if (conn && conn.open) conn.send({ type: 'rematch_request' });
        document.getElementById('rematchBtn').disabled = true;
        document.getElementById('pendingNote').textContent = 'بانتظار قبول الخصم…';
        document.getElementById('pendingNote').style.display = 'block';
    };

    window.acceptRematch = function() {
        document.getElementById('rematchRequestVeil').classList.remove('show');
        if (conn && conn.open) conn.send({ type: 'rematch_accept' });
        resetGameState(true);
    };

    window.declineRematch = function() {
        document.getElementById('rematchRequestVeil').classList.remove('show');
        if (conn && conn.open) conn.send({ type: 'rematch_decline' });
    };

    window.confirmResign = function() {
        document.getElementById('resignConfirmVeil').classList.remove('show');
        localStorage.removeItem(STORAGE_KEY);
        if (conn && conn.open) conn.send({ type: 'resign' });
        showResult('لقد انسحبت', 'فاز خصمك بالمباراة.', true);
    };

    function handleOpponentResign() {
        if (gameEnded) return;
        stopClock();
        localStorage.removeItem(STORAGE_KEY);
        const winnerName = (myColor === 'w') ? 'الأبيض (أنت)' : 'الأسود (أنت)';
        showResult('فزت بالمباراة! 🎉', 'انسحب خصمك من اللعبة.', true);
    }

    window.cancelResign = function() {
        document.getElementById('resignConfirmVeil').classList.remove('show');
    };

    document.getElementById('resignBtn').addEventListener('click', () => {
        if (gameEnded) return;
        document.getElementById('resignConfirmVeil').classList.add('show');
    });

    document.getElementById('drawBtn').addEventListener('click', () => {
        if (gameEnded || !conn || !conn.open) return;
        document.getElementById('drawConfirmVeil').classList.add('show');
    });

    window.confirmDrawOffer = function() {
        document.getElementById('drawConfirmVeil').classList.remove('show');
        if (conn && conn.open) conn.send({ type: 'draw_offer' });
    };

    window.cancelDrawOffer = function() {
        document.getElementById('drawConfirmVeil').classList.remove('show');
    };

    window.acceptDrawOffer = function() {
        document.getElementById('drawRequestVeil').classList.remove('show');
        localStorage.removeItem(STORAGE_KEY);
        if (conn && conn.open) conn.send({ type: 'draw_accept' });
        showResult('تعادل باتفاق الطرفين', 'تم إنهاء الجيم بالصلح الودي.', true);
    };

    window.declineDrawOffer = function() {
        document.getElementById('drawRequestVeil').classList.remove('show');
        if (conn && conn.open) conn.send({ type: 'draw_decline' });
    };

    window.promotePiece = function(piece) {
        if (!pendingPromotion) return;

        const move = game.move({ 
            from: pendingPromotion.source, 
            to: pendingPromotion.target, 
            promotion: piece 
        });

        if (!move) {
            pendingPromotion = null;
            document.getElementById('promotionBox').style.display = 'none';
            board.position(game.fen());
            return;
        }

        if (turnMoveCount === 0 && game.in_check()) {
            game.undo(); // التراجع عن النقلة
            pendingPromotion = null;
            document.getElementById('promotionBox').style.display = 'none';
            board.position(game.fen()); // إرجاع القطعة لمكانها على الرقعة
            return;
        }

        document.getElementById('promotionBox').style.display = 'none';
        board.position(game.fen());

        sendMove({ 
            from: pendingPromotion.source, 
            to: pendingPromotion.target, 
            promotion: piece 
        });

        pendingPromotion = null;
        processTurnIncrement();
        checkGameEnd();
    };

    let promotionBoxJustOpened = false;

    function showPromotionBox() {
        const piecePrefix = promoColor === 'w' ? 'w' : 'b';
        document.getElementById('promo-q').src = PIECE_THEME.replace('{piece}', piecePrefix + 'Q');
        document.getElementById('promo-r').src = PIECE_THEME.replace('{piece}', piecePrefix + 'R');
        document.getElementById('promo-b').src = PIECE_THEME.replace('{piece}', piecePrefix + 'B');
        document.getElementById('promo-n').src = PIECE_THEME.replace('{piece}', piecePrefix + 'N');
        document.getElementById('promotionBox').style.display = 'block';
        promotionBoxJustOpened = true;
        setTimeout(() => { promotionBoxJustOpened = false; }, 100);
    }

    function hidePromotionBox() {
        document.getElementById('promotionBox').style.display = 'none';
        pendingPromotion = null;
    }

    document.addEventListener('click', function(e) {
        if (promotionBoxJustOpened) return;
        const box = document.getElementById('promotionBox');
        if (box.style.display === 'block' && !box.contains(e.target)) {
            hidePromotionBox();
        }
    });

    function sendMove(moveMsg) {
        if (conn && conn.open) conn.send({ type: 'move', move: moveMsg });
    }

    function applyRemoteMove(moveMsg) {
        const move = game.move({ from: moveMsg.from, to: moveMsg.to, promotion: moveMsg.promotion || 'q' });
        if (move === null) return;
        board.position(game.fen());
        processTurnIncrement();
        checkGameEnd();
    }

    function sendFullSyncState() {
        if (conn && conn.open) {
            conn.send({
                type: 'sync_state',
                state: {
                    fen: game.fen(),
                    activeTurn: activeTurn,
                    turnMoveCount: turnMoveCount,
                    clocks: clocks,
                    firstMoveDone: firstMoveDone,
                    currentGraceLeft: currentGraceLeft
                }
            });
        }
    }

    function handleSyncState(remoteState) {
        game.load(remoteState.fen);
        activeTurn = remoteState.activeTurn;
        turnMoveCount = remoteState.turnMoveCount;
        clocks = remoteState.clocks;
        firstMoveDone = remoteState.firstMoveDone;
        currentGraceLeft = remoteState.currentGraceLeft;
        
        board.position(game.fen());
        updateTurnStrip();
        updateClockDisplay();
        saveGameToStorage();
        startClock();
    }

    function setConnected(isConnected) {
        const pill = document.getElementById('connPill');
        const text = document.getElementById('connText');
        pill.classList.toggle('connected', isConnected);
        text.textContent = isConnected ? 'متصل' : 'جاري الاتصال…';
        
        document.getElementById('waitingVeil').classList.toggle('show', isHost && !isConnected);
        
        if (isConnected) {
            sendFullSyncState();
            startClock();
        } else {
            stopClock();
        }
    }

    function wireConnection(connection) {
        conn = connection;
        conn.on('open', () => setConnected(true));
        conn.on('data', (data) => {
            if (!data || !data.type) return;
            if (data.type === 'move') {
                applyRemoteMove(data.move);
            } else if (data.type === 'sync_state') {
                handleSyncState(data.state);
            } else if (data.type === 'rematch_request') {
                document.getElementById('rematchRequestVeil').classList.add('show');
            } else if (data.type === 'rematch_accept') {
                resetGameState(true);
            } else if (data.type === 'rematch_decline') {
                handleRematchDeclined();
            } else if (data.type === 'resign') {
                handleOpponentResign();
            } else if (data.type === 'timeout') {
                handleOpponentTimeout(data.color);
            } else if (data.type === 'draw_offer') {
                if (!gameEnded) document.getElementById('drawRequestVeil').classList.add('show');
            } else if (data.type === 'draw_accept') {
                showResult('تعادل باتفاق الطرفين', 'قبل خصمك عرض التعادل.', true);
            } else if (data.type === 'draw_decline') {
                alert('رفض الخصم عرض التعادل، كمل لعب!');
            }
        });
        conn.on('close', () => {
            setConnected(false);
            if (!localStorage.getItem(STORAGE_KEY)) {
                showError('قطع خصمك الاتصال باللعبة.');
            } else {
                document.getElementById('connText').textContent = 'الخصم بيعمل ريفريش.اعمل انت كمان عشان يرجع..';
            }
        });
    }

    function showError(msg) {
        document.getElementById('errorText').textContent = msg;
        document.getElementById('errorVeil').classList.add('add', 'show');
    }

    function initPeer() {
        if (isHost) {
            peer = new Peer(hostId);
            peer.on('open', () => setConnected(false));
            peer.on('connection', (connection) => wireConnection(connection));
        } else {
            peer = new Peer();
            peer.on('open', () => {
                const connection = peer.connect(hostId, { reliable: true });
                wireConnection(connection);
            });
        }
        peer.on('error', (err) => {
            console.error(err);
            setTimeout(() => {
                if (!conn || !conn.open) initPeer();
            }, 2000);
        });
    }

    const hasSavedGame = loadGameFromStorage();

    board = Chessboard('myBoard', {
        draggable: false,
        position: hasSavedGame ? game.fen() : 'start',
        orientation: (myColor === 'w') ? 'white' : 'black',
        pieceTheme: PIECE_THEME,
        onMouseoutSquare: function() { if (!selectedSquare) removeGreySquares(); },
        onMouseoverSquare: onMouseoverSquare
    });

    window.addEventListener('resize', () => board.resize());

    document.getElementById('myBoard').addEventListener('click', function(e) {
        const squareEl = e.target.closest('[class*="square-"]');
        if (!squareEl) return;
        const square = getSquareFromElement(squareEl);
        if (!square) return;
        onSquareTap(square);
    });

    updateTurnStrip();
    updateClockDisplay();
    setConnected(false);
    initPeer();
    
})();
