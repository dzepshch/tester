import os
import json
import csv
import io
import secrets
from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS
import psycopg
from psycopg.rows import dict_row

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, '..', 'static')
TEMPLATES_DIR = os.path.join(BASE_DIR, '..', 'templates')

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATES_DIR)
CORS(app)

ADMIN_KEY = os.environ.get('ADMIN_KEY', 'admin123')

# ─── DB ───────────────────────────────────────────────────────────────────────

def get_db():
    url = os.environ.get('DATABASE_URL')
    if not url:
        raise RuntimeError('DATABASE_URL is not set')
    return psycopg.connect(url, row_factory=dict_row, prepare_threshold=None)

_db_initialized = False

def ensure_db():
    global _db_initialized
    if _db_initialized:
        return
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS tests (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                time_limit INTEGER DEFAULT 0,
                time_per_question INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                active INTEGER DEFAULT 1
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS questions (
                id SERIAL PRIMARY KEY,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                image TEXT,
                multiple INTEGER DEFAULT 0,
                sort_order INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS answers (
                id SERIAL PRIMARY KEY,
                question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                correct INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS results (
                id SERIAL PRIMARY KEY,
                test_id INTEGER NOT NULL REFERENCES tests(id),
                session_id TEXT NOT NULL,
                score INTEGER DEFAULT 0,
                total INTEGER DEFAULT 0,
                time_spent INTEGER DEFAULT 0,
                finished_at TIMESTAMPTZ DEFAULT NOW()
            )
        ''')
        row = conn.execute('SELECT COUNT(*) as c FROM tests').fetchone()
        if row['c'] == 0:
            _seed_demo(conn)
    _db_initialized = True

def _seed_demo(conn):
    row = conn.execute(
        "INSERT INTO tests (title, description, time_limit) VALUES (%s, %s, %s) RETURNING id",
        ("История России", "Тест по теме Петровских реформ", 300)
    ).fetchone()
    test_id = row['id']
    row = conn.execute(
        "INSERT INTO questions (test_id, text, multiple, sort_order) VALUES (%s, %s, 0, 1) RETURNING id",
        (test_id, "Кто был первым российским императором?")
    ).fetchone()
    q1 = row['id']
    for txt, correct in [("Пётр I", 1), ("Иван IV", 0), ("Александр I", 0)]:
        conn.execute("INSERT INTO answers (question_id, text, correct) VALUES (%s, %s, %s)", (q1, txt, correct))
    row = conn.execute(
        "INSERT INTO questions (test_id, text, multiple, sort_order) VALUES (%s, %s, 1, 2) RETURNING id",
        (test_id, "Выберите реформы Петра I")
    ).fetchone()
    q2 = row['id']
    for txt, correct in [("Создание Сената", 1), ("Отмена крепостного права", 0), ("Введение Табели о рангах", 1)]:
        conn.execute("INSERT INTO answers (question_id, text, correct) VALUES (%s, %s, %s)", (q2, txt, correct))

# ─── AUTH ─────────────────────────────────────────────────────────────────────

def check_admin(req):
    key = req.headers.get("X-Admin-Key") or req.args.get("key", "")
    if not key:
        try:
            key = (req.get_json(silent=True) or {}).get("key", "")
        except Exception:
            key = ""
    return key == ADMIN_KEY

# ─── HELPERS ──────────────────────────────────────────────────────────────────

def serialize(row):
    d = dict(row)
    for k, v in d.items():
        if hasattr(v, 'isoformat'):
            d[k] = v.isoformat()
    return d

def test_to_dict(row, include_questions=False):
    d = serialize(row)
    if include_questions:
        with get_db() as conn:
            questions = conn.execute(
                'SELECT * FROM questions WHERE test_id=%s ORDER BY sort_order', (d['id'],)
            ).fetchall()
            qs = []
            for q in questions:
                qd = dict(q)
                answers = conn.execute(
                    'SELECT * FROM answers WHERE question_id=%s', (q['id'],)
                ).fetchall()
                qd['answers'] = [dict(a) for a in answers]
                qs.append(qd)
            d['questions'] = qs
    return d

# ─── BEFORE REQUEST ───────────────────────────────────────────────────────────

@app.before_request
def before_request():
    ensure_db()

# ─── ROUTES: STATIC ───────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory(TEMPLATES_DIR, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    tpl = os.path.join(TEMPLATES_DIR, path)
    if os.path.isfile(tpl):
        return send_from_directory(TEMPLATES_DIR, path)
    return send_from_directory(STATIC_DIR, path)

# ─── API: TESTS ───────────────────────────────────────────────────────────────

@app.route('/api/tests', methods=['GET'])
def get_tests():
    with get_db() as conn:
        rows = conn.execute(
            '''SELECT t.*,
               COUNT(DISTINCT r.id) as attempts,
               ROUND(AVG(CASE WHEN r.total>0 THEN r.score*100.0/r.total END)::numeric, 1) as avg_score
               FROM tests t
               LEFT JOIN results r ON r.test_id = t.id
               WHERE t.active=1
               GROUP BY t.id
               ORDER BY t.created_at DESC'''
        ).fetchall()
    return jsonify([serialize(r) for r in rows])

@app.route('/api/tests/<int:test_id>', methods=['GET'])
def get_test(test_id):
    with get_db() as conn:
        row = conn.execute('SELECT * FROM tests WHERE id=%s AND active=1', (test_id,)).fetchone()
        if not row:
            abort(404)
        d = test_to_dict(row, include_questions=True)
        if not check_admin(request):
            for q in d.get('questions', []):
                for a in q.get('answers', []):
                    a.pop('correct', None)
    return jsonify(d)

@app.route('/api/tests/<int:test_id>/check', methods=['POST'])
def check_answers(test_id):
    data = request.json or {}
    answers_submitted = data.get('answers', {})

    with get_db() as conn:
        test = conn.execute('SELECT * FROM tests WHERE id=%s AND active=1', (test_id,)).fetchone()
        if not test:
            abort(404)
        questions = conn.execute(
            'SELECT * FROM questions WHERE test_id=%s ORDER BY sort_order', (test_id,)
        ).fetchall()

        results = {}
        score = 0
        total = len(questions)

        for q in questions:
            qid = str(q['id'])
            submitted = set(str(x) for x in answers_submitted.get(qid, []))
            correct_answers = conn.execute(
                'SELECT id FROM answers WHERE question_id=%s AND correct=1', (q['id'],)
            ).fetchall()
            correct_ids = set(str(a['id']) for a in correct_answers)
            all_answers = conn.execute(
                'SELECT * FROM answers WHERE question_id=%s', (q['id'],)
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

        session_id = data.get('session_id', secrets.token_hex(8))
        time_spent = data.get('time_spent', 0)
        conn.execute(
            'INSERT INTO results (test_id, session_id, score, total, time_spent) VALUES (%s,%s,%s,%s,%s)',
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
    session_id = request.args.get('session_id', '')
    if not session_id:
        return jsonify([])
    with get_db() as conn:
        rows = conn.execute(
            '''SELECT r.*, t.title FROM results r
               JOIN tests t ON t.id = r.test_id
               WHERE r.session_id=%s ORDER BY r.finished_at DESC''',
            (session_id,)
        ).fetchall()
    return jsonify([serialize(r) for r in rows])

# ─── API: ADMIN ───────────────────────────────────────────────────────────────

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
               ROUND(AVG(CASE WHEN r.total>0 THEN r.score*100.0/r.total END)::numeric, 1) as avg_score
               FROM tests t
               LEFT JOIN results r ON r.test_id = t.id
               GROUP BY t.id ORDER BY t.created_at DESC'''
        ).fetchall()
    return jsonify([serialize(r) for r in rows])

@app.route('/api/admin/tests', methods=['POST'])
def admin_create_test():
    if not check_admin(request):
        abort(403)
    data = request.json or {}
    title = data.get('title', '').strip()
    if not title:
        return jsonify({'error': 'Название обязательно'}), 400

    with get_db() as conn:
        row = conn.execute(
            'INSERT INTO tests (title, description, time_limit, time_per_question) VALUES (%s,%s,%s,%s) RETURNING id',
            (title, data.get('description', ''), data.get('time_limit', 0), data.get('time_per_question', 0))
        ).fetchone()
        test_id = row['id']
        for i, q in enumerate(data.get('questions', [])):
            row = conn.execute(
                'INSERT INTO questions (test_id, text, image, multiple, sort_order) VALUES (%s,%s,%s,%s,%s) RETURNING id',
                (test_id, q.get('text', ''), q.get('image'), int(q.get('multiple', False)), i)
            ).fetchone()
            qid = row['id']
            for a in q.get('answers', []):
                conn.execute(
                    'INSERT INTO answers (question_id, text, correct) VALUES (%s,%s,%s)',
                    (qid, a.get('text', ''), int(a.get('correct', False)))
                )
    return jsonify({'id': test_id, 'ok': True})

@app.route('/api/admin/tests/<int:test_id>', methods=['GET'])
def admin_get_test(test_id):
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        row = conn.execute('SELECT * FROM tests WHERE id=%s', (test_id,)).fetchone()
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
            'UPDATE tests SET title=%s, description=%s, time_limit=%s, time_per_question=%s, active=%s WHERE id=%s',
            (data.get('title'), data.get('description', ''),
             data.get('time_limit', 0), data.get('time_per_question', 0),
             int(data.get('active', 1)), test_id)
        )
        if 'questions' in data:
            conn.execute('DELETE FROM questions WHERE test_id=%s', (test_id,))
            for i, q in enumerate(data['questions']):
                row = conn.execute(
                    'INSERT INTO questions (test_id, text, image, multiple, sort_order) VALUES (%s,%s,%s,%s,%s) RETURNING id',
                    (test_id, q.get('text', ''), q.get('image'), int(q.get('multiple', False)), i)
                ).fetchone()
                qid = row['id']
                for a in q.get('answers', []):
                    conn.execute(
                        'INSERT INTO answers (question_id, text, correct) VALUES (%s,%s,%s)',
                        (qid, a.get('text', ''), int(a.get('correct', False)))
                    )
    return jsonify({'ok': True})

@app.route('/api/admin/tests/<int:test_id>', methods=['DELETE'])
def admin_delete_test(test_id):
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        conn.execute('DELETE FROM tests WHERE id=%s', (test_id,))
    return jsonify({'ok': True})

@app.route('/api/admin/tests/<int:test_id>/toggle', methods=['POST'])
def admin_toggle_test(test_id):
    if not check_admin(request):
        abort(403)
    with get_db() as conn:
        conn.execute('UPDATE tests SET active = 1 - active WHERE id=%s', (test_id,))
        row = conn.execute('SELECT active FROM tests WHERE id=%s', (test_id,)).fetchone()
    return jsonify({'active': row['active']})

@app.route('/api/admin/import', methods=['POST'])
def admin_import():
    if not check_admin(request):
        abort(403)
    if 'file' not in request.files:
        return jsonify({'error': 'Файл не найден'}), 400

    f = request.files['file']
    filename = f.filename.lower()

    try:
        if filename.endswith('.json'):
            data = json.load(f)
            tests = data if isinstance(data, list) else [data]
        elif filename.endswith('.csv'):
            content = f.read().decode('utf-8-sig')
            reader = csv.DictReader(io.StringIO(content))
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
                row = conn.execute(
                    'INSERT INTO tests (title, description, time_limit) VALUES (%s,%s,%s) RETURNING id',
                    (test_data.get('title', 'Без названия'),
                     test_data.get('description', ''),
                     test_data.get('time_limit', 0))
                ).fetchone()
                tid = row['id']
                for i, q in enumerate(test_data.get('questions', [])):
                    row = conn.execute(
                        'INSERT INTO questions (test_id, text, image, multiple, sort_order) VALUES (%s,%s,%s,%s,%s) RETURNING id',
                        (tid, q.get('text', ''), q.get('image'), int(q.get('multiple', False)), i)
                    ).fetchone()
                    qid = row['id']
                    for a in q.get('answers', []):
                        conn.execute(
                            'INSERT INTO answers (question_id, text, correct) VALUES (%s,%s,%s)',
                            (qid, a.get('text', ''), int(a.get('correct', False)))
                        )
                created.append(tid)

        return jsonify({'ok': True, 'created': created})
    except Exception as e:
        return jsonify({'error': str(e)}), 400

if __name__ == '__main__':
    app.run(debug=True, port=5000)
