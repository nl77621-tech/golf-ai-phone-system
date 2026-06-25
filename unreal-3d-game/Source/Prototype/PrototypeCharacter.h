#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "PrototypeCharacter.generated.h"

class UCameraComponent;
class USpringArmComponent;

/**
 * Default third-person player character.
 *
 * Uses the classic axis/action input mappings defined in Config/DefaultInput.ini
 * so the project builds and plays without any binary input assets. When you are
 * ready, you can migrate this to Enhanced Input (Input Actions + Mapping Contexts
 * created in the editor) for the modern UE 5 workflow.
 */
UCLASS()
class PROTOTYPE_API APrototypeCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	APrototypeCharacter();

protected:
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	/** Movement input handlers, relative to the controller's yaw. */
	void MoveForward(float Value);
	void MoveRight(float Value);

	/** Gamepad look handlers, scaled by TurnRateGamepad and frame time. */
	void TurnAtRate(float Rate);
	void LookUpAtRate(float Rate);

	/** Spring arm that positions the camera behind the character. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Camera", meta = (AllowPrivateAccess = "true"))
	USpringArmComponent* CameraBoom;

	/** Follow camera attached to the spring arm. */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Camera", meta = (AllowPrivateAccess = "true"))
	UCameraComponent* FollowCamera;

	/** Gamepad look rate, in degrees per second. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Input")
	float TurnRateGamepad = 50.0f;
};
