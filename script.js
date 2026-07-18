(function() {
    const PIECE_THEME = 'pieces/{piece}.png';

    const params = new URLSearchParams(window.location.search);
    const hostId = params.get('host');
    const isHost = params.get('as') === 'host';

    if (!hostId) {
        showError('لم يتم العثور على رابط اللعبة. اطلب من خصمك رابطاً جديداً، أو ابدأ لعبة جديدة.');
        return;
    }

    // مفتاح فريد لحفظ اللعبة الحالية في الـ localStorage بناءً على الـ hostId
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

    const BASE_TIME = 180;
    const INCREMENT = 2;
    const GRACE_TIME = 10;

    let clocks = { w: BASE_TIME, b: BASE_TIME };
    let firstMoveDone = { w: false, b: false };
    let currentGraceLeft = GRACE_TIME;

    let clockInterval = null;
    let lastTick = null;

    // دالة لحفظ حالة اللعبة الحالية في متصفح اللاعب
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

    // دالة لمحاولة استعادة اللعبة من الـ Storage عند الـ Refresh
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
        
        // حفظ الوقت بشكل دوري أثناء الحساب لحمايته عند الـ Refresh
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

    function removeGreySquares() {
        $('#myBoard .square-55d63').css('background', '');
    }

    function greySquare(square) {
        const $sq = $('#myBoard .square-' + square);
        $sq.css('background', $sq.hasClass('black-3c85d') ? '#5c5346' : '#7a6f5d');
    }

    const onDragStart = function(source, piece) {
        if (game.game_over() || gameEnded) return false;
        if (!conn || !conn.open) return false;
        if (activeTurn !== myColor) return false;
        if ((myColor === 'w' && piece.search(/^b/) !== -1) ||
            (myColor === 'b' && piece.search(/^w/) !== -1)) {
            return false;
        }
    };

    const onDrop = function(source, target) {
        removeGreySquares();
        const move = game.move({ from: source, to: target, promotion: 'q' });
        if (move === null) return 'snapback';

        if (turnMoveCount === 0 && game.in_check()) {
            game.undo();
            return 'snapback';
        }

        if (move.flags.includes('p')) {
            pendingPromotion = { source: source, target: target };
            promoColor = activeTurn;
            game.undo();
            showPromotionBox();
            return 'snapback';
        }

        sendMove({ from: source, to: target, promotion: null });
        processTurnIncrement();
        checkGameEnd();
    };

    const onMouseoverSquare = function(square) {
        if (activeTurn !== myColor) return;
        const moves = game.moves({ square: square, verbose: true });
        if (!moves.length) return;
        greySquare(square);
        moves.forEach(m => greySquare(m.to));
    };

    const onSnapEnd = function() {
        board.position(game.fen());
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

    // === أضف هذه الدالة هنا ليستقبل الخصم إشعار الانسحاب ===
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
        const move = game.move({ from: pendingPromotion.source, to: pendingPromotion.target, promotion: piece });
        if (turnMoveCount === 0 && game.in_check()) {
            game.undo();
            pendingPromotion = null;
            document.getElementById('promotionBox').style.display = 'none';
            board.position(game.fen());
            return;
        }
        sendMove({ from: pendingPromotion.source, to: pendingPromotion.target, promotion: piece });
        pendingPromotion = null;
        document.getElementById('promotionBox').style.display = 'none';
        board.position(game.fen());
        processTurnIncrement();
        checkGameEnd();
    };

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

    // دالة لمزامنة وإرسال الحالة الكاملة عند عودة لاعب من الـ Refresh
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
        
        // إخفاء ستار الانتظار لو متصل
        document.getElementById('waitingVeil').classList.toggle('show', isHost && !isConnected);
        
        if (isConnected) {
            // لو رجعنا من ريفريش، نطلب مزامنة الحالة مع الخصم فوراً
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
            // لو الجيم لسه شغال في الـ storage مش هنظهر شاشة الخطأ فوراً، هندي فرصة للخصم يرجع ريفريش
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
            // لو الهوست بيعمل ريفريش، الـ Peer القديم بيموت، فبنحاول نعيد المحاولة بعد ثانيتين بدل ما نقفل بـ Error
            setTimeout(() => {
                if (!conn || !conn.open) initPeer();
            }, 2000);
        });
    }

    // محاولة استعادة الحالة القديمة قبل بناء الرقعة
    const hasSavedGame = loadGameFromStorage();

    board = Chessboard('myBoard', {
        draggable: true,
        position: hasSavedGame ? game.fen() : 'start',
        orientation: (myColor === 'w') ? 'white' : 'black',
        pieceTheme: PIECE_THEME,
        onDragStart: onDragStart,
        onDrop: onDrop,
        onMouseoutSquare: removeGreySquares,
        onMouseoverSquare: onMouseoverSquare,
        onSnapEnd: onSnapEnd
    });

    window.addEventListener('resize', () => board.resize());

    updateTurnStrip();
    updateClockDisplay();
    setConnected(false);
    initPeer();
    
})();