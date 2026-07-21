<?php
namespace App\Controller;

use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Annotation\Route;

#[Route('/api/foo')]
final class FooController
{
    #[Route('/{id}', name: 'foo_show', methods: ['GET'])]
    public function show(int $id): Response
    {
        return new Response('ok');
    }

    #[Route('', name: 'foo_create', methods: ['POST'])]
    public function create(): Response
    {
        return new Response('ok');
    }
}
