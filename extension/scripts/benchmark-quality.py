"""Evaluate numeric fixture functions with an AST interpreter, never exec/eval.

This deliberately accepts only a small numeric Python subset. Unsupported code
fails validation; model output cannot import, access attributes, loop or run IO.
"""
import ast
import json
import operator
import sys

PAIRS = [(2, 5), (5, 2), (3, 3), (-3, -8), (0, 0), (1.5, 1.2)]
COMPARE = {ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Lt: operator.lt,
           ast.LtE: operator.le, ast.Eq: operator.eq, ast.NotEq: operator.ne}
ARITHMETIC = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul}
ALLOWED = (ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return,
           ast.If, ast.IfExp, ast.Compare, ast.Name, ast.Constant, ast.Load,
           ast.Store, ast.Call, ast.Assign, ast.AnnAssign, ast.Expr, ast.BinOp,
           ast.UnaryOp, ast.USub, ast.UAdd, *COMPARE, *ARITHMETIC)


def expression(node, names):
    if isinstance(node, ast.Name):
        return names[node.id]
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        if abs(node.value) > 10**9:
            raise ValueError("Numeric literal too large")
        return node.value
    if isinstance(node, ast.UnaryOp):
        value = expression(node.operand, names)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp):
        value = ARITHMETIC[type(node.op)](expression(node.left, names), expression(node.right, names))
        if abs(value) > 10**12:
            raise ValueError("Numeric result too large")
        return value
    if isinstance(node, ast.Compare):
        left = expression(node.left, names)
        for comparison, right_node in zip(node.ops, node.comparators):
            right = expression(right_node, names)
            if not COMPARE[type(comparison)](left, right):
                return False
            left = right
        return True
    if isinstance(node, ast.IfExp):
        return expression(node.body if expression(node.test, names) else node.orelse, names)
    if isinstance(node, ast.Call):
        function = {"max": max, "min": min}[node.func.id]
        return function(expression(arg, names) for arg in node.args)
    raise ValueError("Unsupported expression")


def statements(nodes, names):
    for node in nodes:
        if isinstance(node, ast.Return):
            return True, expression(node.value, names)
        if isinstance(node, ast.If):
            returned, value = statements(node.body if expression(node.test, names) else node.orelse, names)
            if returned:
                return returned, value
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if not isinstance(target, ast.Name) or target.id in ("max", "min"):
                    raise ValueError("Unsupported assignment")
                names[target.id] = expression(node.value, names)
        elif not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
            raise ValueError("Unsupported statement")
    return False, None


def validate(source, kind):
    if len(source) > 16384:
        raise ValueError("Source exceeds fixture limit")
    tree = ast.parse(source)
    nodes = list(ast.walk(tree))
    if len(nodes) > 512 or any(not isinstance(node, ALLOWED) for node in nodes):
        raise ValueError("Unsupported syntax")
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise ValueError("Expected one function")
    function = tree.body[0]
    args = function.args
    parameters = args.posonlyargs + args.args
    if len(parameters) != 2 or args.defaults or args.kwonlyargs or args.vararg or args.kwarg or function.decorator_list:
        raise ValueError("Expected two ordinary parameters")
    if any(arg.arg in ("max", "min") for arg in parameters):
        raise ValueError("Shadowed builtin")
    for node in nodes:
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in ("max", "min") or node.keywords or len(node.args) != 2):
            raise ValueError("Unsupported call")
    target = {"maximum": max, "addition": operator.add}[kind]
    for a, b in PAIRS:
        returned, result = statements(function.body, {parameters[0].arg: a, parameters[1].arg: b})
        if not returned or result != target(a, b):
            return False
    return True


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read(32768))
        print(json.dumps({"passed": validate(request["source"], request["kind"]), "inputPairs": len(PAIRS)}))
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error)}))
