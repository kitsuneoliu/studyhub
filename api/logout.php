<?php
require __DIR__ . '/config.php';

$_SESSION = [];
session_unset();
session_destroy();

echo json_encode(['success' => true]);
