import os
import json
import csv
import io
import hashlib
import secrets
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('DB_PATH', os.path.join('/tmp', 'tester.db'))
STATIC_DIR = os.path.join(BASE_DIR, '..', 'static')
TEMPLATES_DIR = os.path.join(BASE_DIR, '..', 'templates')

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATES_DIR)
CORS(app)

ADMIN_KEY = os.environ.get('ADMIN_KEY', 'admin123')

# ─── DB SETUP ───────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS tests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                time_limit INTEGER DEFAULT 0,
                time_per_question INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                active INTEGER DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                image TEXT,
                multiple INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0,
                FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                correct INTEGER DEFAULT 0,
                FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                test_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                score INTEGER DEFAULT 0,
                total INTEGER DEFAULT 0,
                time_spent INTEGER DEFAULT 0,
                finished_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (test_id) REFERENCES tests(id)
            );
        ''')
        # Seed demo test if empty
        cur = conn.execute('SELECT COUNT(*) as c FROM tests')
        if cur.fetchone()['c'] == 0:
            _seed_demo(conn)

def _seed_demo(conn):
    conn.execute(
        "INSERT INTO tests (title, description, time_limit) VALUES (?, ?, ?)",
        ("История России", "Тест по теме Петровских реформ", 300)
    )
    test_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO questions (test_id, text, multiple, sort_order) VALUES (?, ?, 0, 1)",
        (test_id, "Кто был первым российским императором?")
    )
    q1 = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    for txt, correct in [("Пётр I", 1), ("Иван IV", 0), ("Александр I", 0)]:
        conn.execute("INSERT INTO answers (question_id, text, correct) VALUES (?, ?, ?)", (q1, txt, correct))

    conn.execute(
        "INSERT INTO questions (test_id, text, multiple, sort_order) VALUES (?, ?, 1, 2)",
        (test_id, "Выберите реформы Петра I")
    )
    q2 = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    for txt, correct in [("Создание Сената", 1), ("Отмена крепостного права", 0), ("Введение Табели о рангах", 1)]:
        conn.execute("INSERT INTO answers (question_id, text, correct) VALUES (?, ?, ?)", (q2, txt, correct))

init_db()

# ─── AUTH ────────────────────────────────────────────────────────────────────

def check_admin(req):
    key = req.headers.get("X-Admin-Key") or req.args.get("key", "")
    if not key:
        try:
            key = (req.get_json(silent=True) or {}).get("key", "")
        except Exception:
            key = ""
    return key == ADMIN_KEY




# ─── HELPERS ────────────────────────────────────────────────────────────────

def test_to_dict(row, include_questions=False):
    d = dict(row)
    if include_questions:
        with get_db() as conn:
            questions = conn.execute(
                'SELECT * FROM questions WHERE test_id=? ORDER BY sort_order', (d['id'],)
            ).fetchall()
            qs = []
            for q in questions:
                qd = dict(q)
                answers = conn.execute(
                    'SELECT * FROM answers WHERE question_id=?', (q['id'],)
                ).fetchall()
                qd['answers'] = [dict(a) for a in answers]
                qs.append(qd)
            d['questions'] = qs
    return d

# ─── ROUTES: STATIC ─────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(TEMPLATES_DIR, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    # Try templates first, then static
    tpl = os.path.join(TEMPLATES_DIR, path)
    if os.path.isfile(tpl):
        return send_from_directory(TEMPLATES_DIR, path)
    return send_from_directory(STATIC_DIR, path)

# ─── API: TESTS ─────────────────────────────────────────────────────────────

@app.route('/api/tests', methods=['GET'])
def get_tests():
    with get_db() as conn:
        rows = conn.execute(
            '''SELECT t.*, 
               COUNT(DISTINCT r.id) as attempts,
               ROUND(AVG(CASE WHEN r.total>0 THEN r.score*100.0/r.total END),1) as avg_score
               FROM tests t
               LEFT JOIN results r ON r.test_id = t.id
               WHERE t.active=1
               GROUP BY t.id
               ORDER BY t.created_at DESC'''
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/tests/<int:test_id>', methods=['GET'])
def get_test(test_id):
    with get_db() as conn:
        row = conn.execute('SELECT * FROM tests WHERE id=? AND active=1', (test_id,)).fetchone()
        if not row:
            abort(404)
        d = test_to_dict(row, include_questions=True)
        # Remove correct flags for non-admin
        if not check_admin(request):
            for q in d.get('questions', []):
                for a in q.get('answers', []):
                    del a['correct']
    return jsonify(d)

@app.route('/api/tests/<int:test_id>/check', methods=['POST'])
def check_answers(test_id):
    """Check submitted answers, return correct/wrong per question"""
    data = request.json or {}
    answers_submitted = data.get('answers', {})  # {question_id: [answer_id, ...]}

    with get_db() as conn:
        test = conn.execute('SELECT * FROM tests WHERE id=? AND active=1', (test_id,)).fetchone()
        if not test:
            abort(404)
        questions = conn.execute(
            'SELECT * FROM questions WHERE test_id=? ORDER BY sort_order', (test_id,)
        ).fetchall()

        results = {}
        score = 0
        total = len(questions)

        for q in questions:
            qid = str(q['id'])
            submitted = set(str(x) for x in answers_submitted.get(qid, []))
            correct_answers = conn.execute(
                'SELECT id FROM answers WHERE question_id=? AND correct=1', (q['id'],)
            ).fetchall()
            correct_ids = set(str(a['id']) for a in correct_answers)
            all_answers = conn.execute(
                'SELECT * FROM answers WHERE question_id=?', (q['id'],)
            ).fetchall()

            is_correct = submitted == correct_ids
            if is_correct:
                score += 1

            results[qid] = {
                'correct': is_correct,
                'correct_ids': list(correct_ids),
                'submitted_ids': list(submitted),
                'answers': [dict(a) for a in all_answers]
            }

        # Save result
        session_id = data.get('session_id', secrets.token_hex(8))
        time_spent = data.get('time_spent', 0)
        conn.execute(
            'INSERT INTO results (test_id, session_id, score, total, time_spent) VALUES (?,?,?,?,?)',
            (test_id, session_id, score, total, time_spent)
        )

    return jsonify({
        'score': score,
        'total': total,
        'percent': round(score * 100 / total) if total else 0,
        'results': results,
        'session_id': session_id
    })

@app.route('/api/results', methods=['GET'])
def get_results():
    """Get results for a session"""
    session_id = request.args.get('session_id', '')
    if not session_id:
        return jsonify([])
    with get_db() as conn:
        rows = conn.execute(
            '''SELECT r.*, t.title FROM results r 
               JOIN tests t ON t.id = r.test_id
               WHERE r.session_id=? ORDER BY r.finished_at DESC''',
            (session_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

# ─── API: ADMIN ──────────────────────────────────────────────────────────────

@app.route('/api/admin/verify', methods=['POST'])
def verify_admin():
    if check_admin(request):
        return jsonify({'ok': True})
    return jsonify({'ok': False}), 403

@app.route('/api/admin/tests', methods=['GET'])
def admin_get_tests():
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        rows = conn.execute(
            '''SELECT t.*, 
               COUNT(DISTINCT r.id) as attempts,
               ROUND(AVG(CASE WHEN r.total>0 THEN r.score*100.0/r.total END),1) as avg_score
               FROM tests t
               LEFT JOIN results r ON r.test_id = t.id
               GROUP BY t.id ORDER BY t.created_at DESC'''
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/admin/tests', methods=['POST'])
def admin_create_test():
    if not check_admin(request):
        abort(403)
    data = request.json or {}
    title = data.get('title', '').strip()
    if not title:
        return jsonify({'error': 'Название обязательно'}), 400

    with get_db() as conn:
        conn.execute(
            'INSERT INTO tests (title, description, time_limit, time_per_question) VALUES (?,?,?,?)',
            (title, data.get('description', ''), data.get('time_limit', 0), data.get('time_per_question', 0))
        )
        test_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        for i, q in enumerate(data.get('questions', [])):
            conn.execute(
                'INSERT INTO questions (test_id, text, image, multiple, sort_order) VALUES (?,?,?,?,?)',
                (test_id, q.get('text', ''), q.get('image'), int(q.get('multiple', False)), i)
            )
            qid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            for a in q.get('answers', []):
                conn.execute(
                    'INSERT INTO answers (question_id, text, correct) VALUES (?,?,?)',
                    (qid, a.get('text', ''), int(a.get('correct', False)))
                )
    return jsonify({'id': test_id, 'ok': True})

@app.route('/api/admin/tests/<int:test_id>', methods=['GET'])
def admin_get_test(test_id):
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        row = conn.execute('SELECT * FROM tests WHERE id=?', (test_id,)).fetchone()
        if not row:
            abort(404)
        d = test_to_dict(row, include_questions=True)
    return jsonify(d)

@app.route('/api/admin/tests/<int:test_id>', methods=['PUT'])
def admin_update_test(test_id):
    if not check_admin(request):
        abort(403)
    data = request.json or {}
    with get_db() as conn:
        conn.execute(
            'UPDATE tests SET title=?, description=?, time_limit=?, time_per_question=?, active=? WHERE id=?',
            (data.get('title'), data.get('description', ''),
             data.get('time_limit', 0), data.get('time_per_question', 0),
             int(data.get('active', 1)), test_id)
        )
        # Replace questions
        if 'questions' in data:
            conn.execute('DELETE FROM questions WHERE test_id=?', (test_id,))
            for i, q in enumerate(data['questions']):
                conn.execute(
                    'INSERT INTO questions (test_id, text, image, multiple, sort_order) VALUES (?,?,?,?,?)',
                    (test_id, q.get('text', ''), q.get('image'), int(q.get('multiple', False)), i)
                )
                qid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                for a in q.get('answers', []):
                    conn.execute(
                        'INSERT INTO answers (question_id, text, correct) VALUES (?,?,?)',
                        (qid, a.get('text', ''), int(a.get('correct', False)))
                    )
    return jsonify({'ok': True})

@app.route('/api/admin/tests/<int:test_id>', methods=['DELETE'])
def admin_delete_test(test_id):
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        conn.execute('DELETE FROM tests WHERE id=?', (test_id,))
    return jsonify({'ok': True})

@app.route('/api/admin/tests/<int:test_id>/toggle', methods=['POST'])
def admin_toggle_test(test_id):
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        conn.execute('UPDATE tests SET active = 1 - active WHERE id=?', (test_id,))
        row = conn.execute('SELECT active FROM tests WHERE id=?', (test_id,)).fetchone()
    return jsonify({'active': row['active']})

@app.route('/api/admin/import', methods=['POST'])
def admin_import():
    """Import test from JSON or CSV file"""
    if not check_admin(request):
        abort(403)

    if 'file' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400

    f = request.files['file']
    filename = f.filename.lower()

    try:
        if filename.endswith('.json'):
            data = json.load(f)
            # data is either a single test object or list
            tests = data if isinstance(data, list) else [data]
        elif filename.endswith('.csv'):
            content = f.read().decode('utf-8-sig')
            reader = csv.DictReader(io.StringIO(content))
            # CSV format: test_title, test_description, question_text, answer_text, correct (true/false), multiple
            tests_map = {}
            for row in reader:
                ttitle = row.get('test_title', 'Импортированный тест')
                if ttitle not in tests_map:
                    tests_map[ttitle] = {
                        'title': ttitle,
                        'description': row.get('test_description', ''),
                        'questions_map': {}
                    }
                qt = row.get('question_text', '')
                if qt not in tests_map[ttitle]['questions_map']:
                    tests_map[ttitle]['questions_map'][qt] = {
                        'text': qt,
                        'multiple': row.get('multiple', 'false').lower() == 'true',
                        'answers': []
                    }
                tests_map[ttitle]['questions_map'][qt]['answers'].append({
                    'text': row.get('answer_text', ''),
                    'correct': row.get('correct', 'false').lower() == 'true'
                })
            tests = []
            for t in tests_map.values():
                t['questions'] = list(t.pop('questions_map').values())
                tests.append(t)
        else:
            return jsonify({'error': 'Поддерживаются только JSON и CSV файлы'}), 400

        created = []
        with get_db() as conn:
            for test_data in tests:
                conn.execute(
                    'INSERT INTO tests (title, description, time_limit) VALUES (?,?,?)',
                    (test_data.get('title', 'Без названия'),
                     test_data.get('description', ''),
                     test_data.get('time_limit', 0))
                )
                tid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                for i, q in enumerate(test_data.get('questions', [])):
                    conn.execute(
                        'INSERT INTO questions (test_id, text, image, multiple, sort_order) VALUES (?,?,?,?,?)',
                        (tid, q.get('text', ''), q.get('image'), int(q.get('multiple', False)), i)
                    )
                    qid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                    for a in q.get('answers', []):
                        conn.execute(
                            'INSERT INTO answers (question_id, text, correct) VALUES (?,?,?)',
                            (qid, a.get('text', ''), int(a.get('correct', False)))
                        )
                created.append(tid)

        return jsonify({'ok': True, 'created': created})
    except Exception as e:
        return jsonify({'error': str(e)}), 400

if __name__ == '__main__':
    app.run(debug=True, port=5000)
